import { createConnection, type Socket } from 'node:net'
import { z } from 'zod'
import { releaseVersionPattern } from '@nextskin/updates'
import { DomainError } from '../errors.ts'

const dialect = z.enum(['sqlite', 'mysql', 'postgres'])
const count = z.number().int().nonnegative()
// object 会校验已知字段并去掉未知字段，管理进程加字段时不必同时升级核心。
export const managerStatusSchema = z.object({
  protocol: z.number().int().positive(),
  version: z.string(),
  current: z.string(),
  previous: z.string().nullable(),
  writable: z.boolean(),
  operation: z
    .object({
      kind: z.enum(['prepare', 'apply', 'rollback']),
      version: z.string().nullable(),
      step: z.string(),
      startedAt: z.iso.datetime(),
      progress: z.object({ received: count, total: count }).optional(),
    })
    .nullable(),
  prepared: z
    .object({
      version: z.string(),
      preflight: z.object({
        dialect,
        pendingCore: count,
        pendingPlugins: count,
        tier: z.enum(['none', 'sqlite', 'external-backup']),
        incompatiblePlugins: z.array(z.object({ id: z.string(), api: z.string() })),
      }),
    })
    .nullable(),
  lastResult: z
    .object({
      at: z.iso.datetime(),
      kind: z.enum(['update', 'manual', 'legacy', 'rollback']),
      from: z.string().nullable(),
      to: z.string(),
      result: z.enum(['success', 'rolled-back', 'failed']),
      step: z.string().nullable(),
      reason: z.string().nullable(),
    })
    .nullable(),
  failed: z.array(z.string()),
  rollback: z
    .object({
      version: z.string(),
      migrations: z.boolean(),
      dialect: dialect.nullable(),
      backupAvailable: z.boolean(),
    })
    .nullable(),
})
export type ManagerStatus = z.infer<typeof managerStatusSchema>
export const updateManagerSchema = z.discriminatedUnion('available', [
  managerStatusSchema.extend({ available: z.literal(true) }),
  z.object({
    available: z.literal(false),
    reason: z.enum(['docker', 'source', 'unmanaged', 'unreachable', 'readonly']),
  }),
])
export type UpdateManager = z.infer<typeof updateManagerSchema>

export const managerErrorCodes = [
  'unauthorized',
  'invalid_request',
  'busy',
  'readonly',
  'not_prepared',
  'not_newer',
  'unknown_version',
  'manager_outdated',
  'node_too_old',
  'backup_required',
  'confirmation_required',
  'no_previous',
  'backup_missing',
  'preflight_failed',
  'download_failed',
  'internal',
] as const
export const updateErrorCodes = [
  ...managerErrorCodes.map((code) => `update_${code}` as const),
  'update_unreachable',
] as const
const errorCode = z.enum(managerErrorCodes)
export const updateVersionSchema = z.string().regex(releaseVersionPattern)
export const managerParams = {
  status: z.object({}),
  prepare: z.object({ version: updateVersionSchema }),
  apply: z.object({ version: updateVersionSchema, backupConfirmed: z.boolean() }),
  rollback: z.object({ confirmed: z.boolean() }),
  cancel: z.object({}),
}
export type ManagerMethod = keyof typeof managerParams
export type ManagerParams = { [M in ManagerMethod]: z.infer<(typeof managerParams)[M]> }
const accepted = z.object({ accepted: z.literal(true) })
const results = {
  status: managerStatusSchema,
  prepare: accepted,
  apply: accepted,
  rollback: accepted,
  cancel: z.object({ cancelled: z.boolean() }),
}
export type ManagerResults = { [M in ManagerMethod]: z.infer<(typeof results)[M]> }
const responseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
])
export interface ManagerClientOptions {
  address: string
  token: string
  connect?: (address: string) => Socket
}
const MAX_LINE_BYTES = 64 * 1024

/** 每次请求独占连接，不重试：apply 被接受之后，核心可能随时停机。 */
export function createManagerClient({ address, token, connect = createConnection }: ManagerClientOptions) {
  return {
    request<M extends ManagerMethod>(method: M, params: ManagerParams[M]): Promise<ManagerResults[M]> {
      return new Promise((resolve, reject) => {
        let socket: Socket | undefined
        let timer: ReturnType<typeof setTimeout> | undefined
        let done = false
        let buffer = Buffer.alloc(0)
        function finish(error?: DomainError, result?: ManagerResults[M]) {
          if (done) return
          done = true
          clearTimeout(timer)
          socket?.destroy()
          if (error) reject(error)
          else resolve(result!)
        }
        const unreachable = () => finish(new DomainError('update_unreachable'))
        try {
          const line = JSON.stringify({ token, method, params }) + '\n'
          if (Buffer.byteLength(line) > MAX_LINE_BYTES) return unreachable()
          timer = setTimeout(unreachable, 3_000)
          socket = connect(address)
          socket.once('error', unreachable)
          socket.once('close', unreachable)
          socket.once('end', unreachable)
          socket.once('connect', () => {
            if (done) return
            clearTimeout(timer)
            timer = setTimeout(unreachable, 10_000)
            try {
              socket!.write(line)
            } catch {
              unreachable()
            }
          })
          socket.on('data', (chunk: Buffer) => {
            if (done) return
            if (buffer.length + chunk.length > MAX_LINE_BYTES) return unreachable()
            buffer = Buffer.concat([buffer, chunk])
            const newline = buffer.indexOf(10)
            if (newline < 0) return
            if (newline !== buffer.length - 1) return unreachable()
            try {
              const response = responseSchema.parse(
                JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)),
              )
              if (!response.ok) {
                const parsed = errorCode.safeParse(response.error.code)
                // 即使对端误把请求回显，也不能把令牌带进异常、前端或日志。
                const message = Array.from(response.error.message.replaceAll(token, '[redacted]'))
                  .slice(0, 500)
                  .join('')
                return finish(
                  new DomainError(parsed.success ? `update_${parsed.data}` : 'update_internal', { message }),
                )
              }
              finish(undefined, results[method].parse(response.result) as ManagerResults[M])
            } catch {
              unreachable()
            }
          })
        } catch {
          // 不保留 cause：底层连接错误和解析错误可能包含地址、请求或令牌。
          unreachable()
        }
      })
    },
  }
}
