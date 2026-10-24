import { toIsoTimestamp, transactionWithRetry, type CoreDatabase } from '@nextskin/db'
import { compareVersions, newerReleases } from '@nextskin/updates'
import type { Kysely } from 'kysely'
import { authorize } from '../admin/context.ts'
import { audit } from '../audit/write.ts'
import type { AdminActor } from '../admin/types.ts'
import { DomainError } from '../errors.ts'
import type { JobHandler } from '../jobs/runner.ts'
import { notifyUpdateAvailable } from '../notifications/write.ts'
import { decodeSettingValue, encodeSettingValue } from '../settings/codec.ts'
import { createSettingQueries } from '../settings/queries.ts'
import { coreSettingsNamespace } from '../settings/registry.ts'
import { lockSetting } from '../settings/write.ts'
import { fetchUpdateManifest } from './manifest.ts'
import {
  createManagerClient,
  managerParams,
  type ManagerClientOptions,
  type ManagerParams,
  type UpdateManager,
} from './manager-client.ts'
import { initialUpdateState, storedUpdateState, type UpdateState } from './state.ts'

export const UPDATE_CHECK_JOB = 'core:update-check'
export interface CoreRelease {
  version: string
  deployment: 'bundle' | 'docker'
}
export interface UpdateStatus {
  manager: UpdateManager
  enabled: boolean
  current: string | null
  deployment: 'bundle' | 'docker' | 'source'
  checkedAt: string | null
  failure: UpdateState['failure']
  latest: UpdateState['releases'][number] | null
  target: UpdateState['releases'][number] | null
}
export interface UpdateCheckOptions {
  fetch?: typeof fetch
  keys?: Readonly<Record<string, string>>
}

export function createUpdates(options: {
  db: Kysely<CoreDatabase>
  settings: ReturnType<typeof createSettingQueries>
  secretKey: string
  now: () => Date
  release?: CoreRelease
  updateCheck?: UpdateCheckOptions
  manager?: ManagerClientOptions
}) {
  const { db, settings, secretKey, now, release } = options
  const manager = release?.deployment === 'bundle' && options.manager ? createManagerClient(options.manager) : undefined
  function requireManager() {
    if (!manager) throw new DomainError('updates_unavailable')
    return manager
  }
  async function managerView(): Promise<UpdateManager> {
    if (!release) return { available: false, reason: 'source' }
    if (release.deployment === 'docker') return { available: false, reason: 'docker' }
    if (!manager) return { available: false, reason: 'unmanaged' }
    try {
      const status = await manager.request('status', {})
      return status.writable ? { available: true, ...status } : { available: false, reason: 'readonly' }
    } catch {
      return { available: false, reason: 'unreachable' }
    }
  }
  let inFlight: Promise<void> | undefined
  const authorizeActor = (actor: AdminActor) => transactionWithRetry(db, (tx) => authorize(tx, actor, 'updates.manage'))
  async function view(): Promise<UpdateStatus> {
    const values = await settings.read(['updates.check', 'updates.state'])
    const state = values['updates.state']
    const manager = await managerView()
    const releases = release
      ? state.releases.filter((entry) => compareVersions(entry.version, release.version) > 0)
      : []
    return {
      manager,
      enabled: values['updates.check'],
      current: release?.version ?? null,
      deployment: release?.deployment ?? 'source',
      checkedAt: state.checkedAt,
      failure: state.failure,
      latest: releases[0] ?? null,
      target: manager.available ? (releases.find((entry) => entry.managerProtocol <= manager.protocol) ?? null) : null,
    }
  }
  async function perform() {
    if (!release) return
    const values = await settings.read(['updates.check', 'updates.state'])
    if (!values['updates.check']) return
    const previous = values['updates.state']
    // 成功和失败都限流，网络故障时连点也不会反复出站。
    const last = Math.max(Date.parse(previous.checkedAt ?? '') || 0, Date.parse(previous.failure?.at ?? '') || 0)
    if (last && now().getTime() - last < 30_000) return
    // 网络和验签在事务外完成，SQLite 的全局写锁只用于保存状态和通知。
    const result = await fetchUpdateManifest(options.updateCheck ?? {})
    const at = toIsoTimestamp(now())
    await transactionWithRetry(db, async (tx) => {
      const locked = await lockSetting(tx, 'updates.state', at, secretKey)
      const state =
        locked.stored === undefined
          ? structuredClone(initialUpdateState)
          : decodeSettingValue('updates.state', locked.stored, secretKey)
      if ('failure' in result) {
        state.failure = { at, ...result.failure }
      } else {
        const releases = newerReleases(release.version, result.releases)
        const latest = releases[0]
        state.checkedAt = at
        state.failure = null
        state.rejected = result.rejected
        const protocols = new Set<number>()
        state.releases = releases
          .filter((entry) => {
            if (protocols.has(entry.managerProtocol)) return false
            protocols.add(entry.managerProtocol)
            return true
          })
          .slice(0, 20)
          .map(({ version, date, notes, minNode, managerProtocol }) => ({
            version,
            date,
            notes,
            minNode,
            managerProtocol,
          }))
        if (latest && !state.notified.includes(latest.version)) {
          await notifyUpdateAvailable(tx, latest.version, at)
          state.notified = [...state.notified, latest.version].slice(-20)
        }
      }
      await tx
        .updateTable('settings')
        .set({
          value: encodeSettingValue('updates.state', storedUpdateState.parse(state), { secretKey }),
          updated_at: at,
        })
        .where('namespace', '=', coreSettingsNamespace)
        .where('key', '=', 'updates.state')
        .execute()
    })
  }
  function run(): Promise<void> {
    if (!inFlight)
      inFlight = perform().finally(() => {
        inFlight = undefined
      })
    return inFlight
  }
  async function command<M extends 'prepare' | 'apply' | 'rollback'>(
    actor: AdminActor,
    method: M,
    params: ManagerParams[M],
  ): Promise<{ accepted: true }> {
    const authorized = await authorizeActor(actor)
    const parsed = managerParams[method].safeParse(params)
    if (!parsed.success) throw new DomainError('invalid_request')
    const input = parsed.data as ManagerParams[M]
    let version = 'version' in input ? input.version : null
    let error: DomainError | undefined
    try {
      const client = requireManager()
      if (method === 'rollback') {
        const status = await client.request('status', {})
        version = status.rollback?.version ?? status.previous
        // 管理进程也拒绝；核心再拦一次，常驻的管理进程可能比核心旧（ADR-0061"回滚"）
        if (status.rollback?.migrations && status.rollback.dialect !== 'sqlite')
          throw new DomainError('update_offline_required')
      }
      await client.request(method, input)
    } catch (cause) {
      error = cause instanceof DomainError ? cause : new DomainError('update_unreachable')
    }
    // IPC 已经结束，再开短事务；拒绝也留痕，原始消息不写进审计。
    await transactionWithRetry(db, (tx) =>
      audit(tx, {
        actor: authorized,
        action: `update.${method}`,
        subject: { type: 'update', id: 0 },
        details: {
          version,
          ...('backupConfirmed' in input ? { backupConfirmed: input.backupConfirmed } : {}),
          ...('confirmed' in input ? { confirmed: input.confirmed } : {}),
          accepted: !error,
          ...(error ? { code: error.code } : {}),
        },
        ip: actor.ip,
        now: toIsoTimestamp(now()),
      }),
    )
    if (error) throw error
    return { accepted: true }
  }
  const handler: JobHandler = { run }
  return {
    handler,
    prepare(actor: AdminActor, version: string) {
      return command(actor, 'prepare', { version })
    },
    apply(actor: AdminActor, version: string, input: { backupConfirmed: boolean }) {
      return command(actor, 'apply', { version, backupConfirmed: input.backupConfirmed })
    },
    rollback(actor: AdminActor, input: { confirmed: boolean }) {
      return command(actor, 'rollback', input)
    },
    async cancel(actor: AdminActor) {
      await authorizeActor(actor)
      return requireManager().request('cancel', {})
    },
    async status(actor: AdminActor): Promise<UpdateStatus> {
      await authorizeActor(actor)
      return view()
    },
    async check(actor: AdminActor): Promise<UpdateStatus> {
      await authorizeActor(actor)
      if (!release) throw new DomainError('updates_unavailable')
      if (!(await settings.read(['updates.check']))['updates.check']) throw new DomainError('updates_disabled')
      await run()
      return view()
    },
  }
}
