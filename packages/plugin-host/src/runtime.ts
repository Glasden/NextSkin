/**
 * 插件侧运行时：持有一个插件的定义，按核心发来的调用执行对应的处理函数。
 *
 * 每次调用都新建一个上下文，绑在这次调用的 invocation 上：插件把 ctx 留到调用结束之后再用，
 * 核心会拒绝那些请求。上下文只放定义里申请过的能力；核心按授予的能力再检查一遍。
 * 事务内的拦截器只拿得到 `db` 和不用等核心回应的几项（SDK 的 TransactionalPluginContext）。
 */
import {
  interceptorPolicies,
  type Json,
  type Logger,
  type PluginFetchInit,
  type RequestScope,
} from '@nextskin/plugin-sdk'
import { Kysely } from 'kysely'
import { z } from 'zod'
import { deserializeRequest, deserializeResponse, serializeRequest, serializeResponse } from './http.ts'
import type { AnyPluginDefinition } from './manifest.ts'
import { translatePlugin, type PluginMessages } from './messages.ts'
import type { CoreRpc, InterceptOutcome, InvocationContext, PluginCall, SerializedResponse } from './protocol.ts'
import { remoteDialect, type CoreDialect } from './remote-dialect.ts'

/** 出站请求体、插件路由响应体的上限（SDK 的 routes.ts） */
export const MAX_FETCH_BODY_BYTES = 10 * 1024 * 1024
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024

export interface LoadedPlugin {
  readonly id: string
  invoke(call: PluginCall, context: InvocationContext): Promise<unknown>
  /** 核心那边已经不等这次调用了（超时或停用）：abort 它的 `ctx.signal`。调用已经结束时什么也不做 */
  cancel(invocationId: string): void
  /** 停用：abort 所有进行中调用的 `ctx.signal`；正常换代先等在途调用完成 */
  unload(): void
}

/** 调用超过了核心给的时间 */
export class PluginTimeoutError extends Error {
  override name = 'PluginTimeoutError'
  constructor() {
    super('plugin call timed out')
  }
}

/** 存着的设置通不过插件自己的 schema：这次调用不执行处理函数 */
export class PluginSettingsInvalidError extends Error {
  override name = 'PluginSettingsInvalidError'
}

export function loadPlugin(options: {
  id: string
  version: string
  definition: AnyPluginDefinition
  messages: PluginMessages
  /** 核心的数据库方言：插件侧用同一套适配器和编译器构建查询 */
  dialect: CoreDialect
  /** 站点的默认语言：插件文案缺少请求的语言时用它 */
  fallbackLocale: string
  rpc: CoreRpc
}): LoadedPlugin {
  const { id, version, definition, messages, dialect, rpc } = options
  const granted = new Set<string>(definition.capabilities as readonly string[])
  const active = new Map<string, AbortController>()
  const settingsSchema = definition.settings as z.ZodObject | undefined

  function parseSettings(values: Readonly<Record<string, Json>>): unknown {
    if (!settingsSchema) return {}
    const result = settingsSchema.safeParse(values)
    if (!result.success) throw new PluginSettingsInvalidError('插件设置不完整或无效；请先在后台的插件设置页填写')
    return Object.freeze(result.data)
  }

  function database(call: string) {
    return new Kysely({ dialect: remoteDialect(dialect, (node) => rpc(call, 'db.query', { node })) })
  }

  function buildContext(context: InvocationContext, signal: AbortSignal, transactional: boolean) {
    const call = context.invocationId
    const t = (key: string, params?: Readonly<Record<string, string | number>>, locale?: string) =>
      translatePlugin(messages, key, {
        locale: locale ?? context.locale,
        fallbackLocale: options.fallbackLocale,
        params,
      })
    const log = Object.fromEntries(
      (['debug', 'info', 'warn', 'error'] as const).map((level) => [
        level,
        (message: string, fields?: Readonly<Record<string, Json>>) => {
          // 不等核心回应：事务内的拦截器也能写日志
          rpc(call, 'log', { level, message: String(message), ...(fields ? { fields } : {}) }).catch(() => {})
        },
      ]),
    ) as unknown as Logger
    const ctx: Record<string, unknown> = {
      plugin: Object.freeze({ id, version }),
      site: Object.freeze({ ...context.site }),
      settings: parseSettings(context.settings),
      t,
      log,
      signal,
    }
    if (granted.has('storage.tables')) ctx.db = database(call)
    if (transactional) return Object.freeze(ctx)

    ctx.jobs = Object.freeze({
      async enqueue(name: string, payload: Json, opts?: { delaySec?: number; dedupeKey?: string }) {
        await rpc(call, 'jobs.enqueue', {
          name,
          payload,
          ...(opts?.delaySec !== undefined ? { delaySec: opts.delaySec } : {}),
          ...(opts?.dedupeKey !== undefined ? { dedupeKey: opts.dedupeKey } : {}),
        })
      },
    })
    ctx.fetch = async (url: string | URL, init?: PluginFetchInit) => {
      const request = new Request(url, { method: init?.method, headers: init?.headers, body: init?.body })
      const response = await rpc(call, 'fetch', await serializeRequest(request, MAX_FETCH_BODY_BYTES))
      return deserializeResponse(response)
    }
    if (granted.has('users.read') || granted.has('users.readPrivate')) {
      ctx.users = Object.freeze({
        get: (uid: number) => rpc(call, 'users.get', { uid }),
        getMany: (uids: readonly number[]) => rpc(call, 'users.getMany', { uids: [...uids] }),
        ...(granted.has('users.readPrivate')
          ? { findByEmail: (email: string) => rpc(call, 'users.findByEmail', { email }) }
          : {}),
      })
    }
    if (granted.has('players.read')) {
      ctx.players = Object.freeze({
        get: (pid: number) => rpc(call, 'players.get', { pid }),
        findByName: (name: string) => rpc(call, 'players.findByName', { name }),
        findByUuid: (uuid: string) => rpc(call, 'players.findByUuid', { uuid }),
        listByUser: (uid: number) => rpc(call, 'players.listByUser', { uid }),
      })
    }
    if (granted.has('textures.read') || granted.has('textures.readFile')) {
      ctx.textures = Object.freeze({
        ...(granted.has('textures.read')
          ? {
              get: (tid: number) => rpc(call, 'textures.get', { tid }),
              findByHash: (hash: string) => rpc(call, 'textures.findByHash', { hash }),
            }
          : {}),
        ...(granted.has('textures.readFile')
          ? { files: Object.freeze({ read: (hash: string) => rpc(call, 'textures.files.read', { hash }) }) }
          : {}),
      })
    }
    if (granted.has('storage.kv')) {
      ctx.kv = Object.freeze({
        get: (key: string) => rpc(call, 'kv.get', { key }),
        async set(key: string, value: Json, opts?: { ttlSec?: number }) {
          await rpc(call, 'kv.set', { key, value, ...(opts?.ttlSec !== undefined ? { ttlSec: opts.ttlSec } : {}) })
        },
        async delete(key: string) {
          await rpc(call, 'kv.delete', { key })
        },
      })
    }
    return Object.freeze(ctx)
  }

  async function run(call: PluginCall, context: InvocationContext, signal: AbortSignal): Promise<unknown> {
    switch (call.kind) {
      case 'event': {
        const handler = definition.on?.[call.event.name] as
          ((args: { event: unknown; ctx: unknown }) => Promise<void>) | undefined
        if (!handler) throw new Error(`插件没有订阅 ${call.event.name}`)
        await handler({ event: call.event, ctx: buildContext(context, signal, false) })
        return null
      }
      case 'job': {
        const job = definition.jobs?.[call.name] as
          { handler(args: { payload: Json; attempt: number; ctx: unknown }): Promise<void> } | undefined
        if (!job) throw new Error(`插件没有声明任务 ${call.name}`)
        await job.handler({ payload: call.payload, attempt: call.attempt, ctx: buildContext(context, signal, false) })
        return null
      }
      case 'intercept': {
        const registration = definition.intercept?.[call.name] as
          ((args: unknown) => Promise<unknown>) | { handler: (args: unknown) => Promise<unknown> } | undefined
        if (!registration) throw new Error(`插件没有拦截 ${call.name}`)
        const handler = typeof registration === 'function' ? registration : registration.handler
        const transactional = interceptorPolicies[call.name].transactional
        const result = await handler({
          input: Object.freeze({ ...call.input, extra: Object.freeze({ ...call.input.extra }) }),
          scope: Object.freeze({ ...call.scope }),
          ctx: buildContext(context, signal, transactional),
        })
        return interceptOutcome(result)
      }
      case 'route': {
        const route = definition.routes?.[`${call.method} ${call.path}` as `GET /${string}`] as
          { handler(args: unknown): Promise<unknown> } | undefined
        if (!route) throw new Error(`插件没有路由 ${call.method} ${call.path}`)
        const response = await route.handler({
          request: deserializeRequest(call.request, signal),
          params: Object.freeze({ ...call.params }),
          scope: Object.freeze({ ...call.scope }) as RequestScope,
          ctx: buildContext(context, signal, false),
        })
        if (!(response instanceof Response)) throw new Error('路由处理函数必须返回 Response')
        return serializeResponse(response, MAX_RESPONSE_BYTES) satisfies Promise<SerializedResponse>
      }
      case 'passwordHasher': {
        const provider = definition.providers?.passwordHasher?.find((item) => item.id === call.provider) as
          { verify(args: { password: string; hash: string; ctx: unknown }): Promise<unknown> } | undefined
        if (!provider) throw new Error(`插件没有 passwordHasher ${call.provider}`)
        const result = await provider.verify({
          password: call.password,
          hash: call.hash,
          ctx: buildContext(context, signal, false),
        })
        if (typeof result !== 'boolean') throw new Error('passwordHasher 的 verify 必须返回布尔值')
        return result
      }
      case 'login.authorize': {
        const provider = definition.providers?.login?.find((item) => item.id === call.provider) as
          { authorizeUrl(args: Record<string, unknown>): Promise<unknown> } | undefined
        if (!provider) throw new Error(`插件没有 login ${call.provider}`)
        const url = await provider.authorizeUrl({
          state: call.state,
          codeChallenge: call.codeChallenge,
          redirectUri: call.redirectUri,
          ctx: buildContext(context, signal, false),
        })
        if (typeof url !== 'string') throw new Error('login 的 authorizeUrl 必须返回字符串')
        return url
      }
      case 'login.exchange': {
        const provider = definition.providers?.login?.find((item) => item.id === call.provider) as
          { exchange(args: Record<string, unknown>): Promise<unknown> } | undefined
        if (!provider) throw new Error(`插件没有 login ${call.provider}`)
        const identity = (await provider.exchange({
          query: Object.freeze({ ...call.query }),
          codeVerifier: call.codeVerifier,
          redirectUri: call.redirectUri,
          ctx: buildContext(context, signal, false),
        })) as Record<string, unknown> | null
        // 只带回约定的字段，插件多给的不跨进程；核心再逐项校验
        if (typeof identity !== 'object' || identity === null) throw new Error('login 的 exchange 必须返回对象')
        return {
          subject: identity.subject,
          email: identity.email,
          emailVerified: identity.emailVerified,
          displayName: identity.displayName,
        }
      }
      case 'migrate': {
        const migration = definition.migrations?.[call.name]
        if (!migration) throw new Error(`插件没有迁移 ${call.name}`)
        // 迁移不读设置：还没填设置的插件也要能先建表
        await migration.up(database(context.invocationId))
        return null
      }
      case 'validateSettings': {
        if (!settingsSchema) return { ok: true, fields: [] }
        const result = settingsSchema.safeParse(call.values)
        if (result.success) return { ok: true, fields: [] }
        const fields = [
          ...new Set(
            result.error.issues.flatMap((issue) => (typeof issue.path[0] === 'string' ? [issue.path[0]] : [])),
          ),
        ]
        return { ok: false, fields }
      }
    }
  }

  return {
    id,
    async invoke(call, context) {
      const controller = new AbortController()
      active.set(context.invocationId, controller)
      const timer = setTimeout(() => controller.abort(new PluginTimeoutError()), context.timeoutMs)
      try {
        const result = await run(call, context, controller.signal)
        // 超时或停用之后才返回的结果不算数：处理函数可能只是在 signal 中止后提前收了尾
        if (controller.signal.aborted) throw controller.signal.reason
        return result
      } finally {
        clearTimeout(timer)
        if (active.get(context.invocationId) === controller) active.delete(context.invocationId)
      }
    },
    cancel(invocationId) {
      active.get(invocationId)?.abort(new PluginTimeoutError())
    },
    unload() {
      for (const controller of active.values()) controller.abort(new Error('plugin unloaded'))
      active.clear()
    },
  }
}

/** 拦截器只能放行（不返回）或拒绝；别的返回值按失败处理 */
function interceptOutcome(result: unknown): InterceptOutcome {
  if (result === undefined || result === null) return null
  const r = result as Record<string, unknown>
  if (
    typeof result === 'object' &&
    r.action === 'deny' &&
    typeof r.code === 'string' &&
    typeof r.message === 'string' &&
    Object.keys(r).every((key) => key === 'action' || key === 'code' || key === 'message')
  )
    return { action: 'deny', code: r.code, message: r.message }
  throw new Error('拦截器只能不返回值，或者返回 deny(code, message)')
}
