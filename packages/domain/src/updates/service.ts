import { toIsoTimestamp, transactionWithRetry, type CoreDatabase } from '@nextskin/db'
import { compareVersions, newerReleases } from '@nextskin/updates'
import type { Kysely } from 'kysely'
import { authorize } from '../admin/context.ts'
import type { AdminActor } from '../admin/types.ts'
import { DomainError } from '../errors.ts'
import type { JobHandler } from '../jobs/runner.ts'
import { notifyUpdateAvailable } from '../notifications/write.ts'
import { decodeSettingValue, encodeSettingValue } from '../settings/codec.ts'
import { createSettingQueries } from '../settings/queries.ts'
import { coreSettingsNamespace } from '../settings/registry.ts'
import { lockSetting } from '../settings/write.ts'
import { fetchUpdateManifest } from './manifest.ts'
import { initialUpdateState, type UpdateState } from './state.ts'

export const UPDATE_CHECK_JOB = 'core:update-check'
export interface CoreRelease {
  version: string
  deployment: 'bundle' | 'docker'
}
export interface UpdateStatus {
  enabled: boolean
  current: string | null
  deployment: 'bundle' | 'docker' | 'source'
  checkedAt: string | null
  failure: UpdateState['failure']
  latest: UpdateState['latest']
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
}) {
  const { db, settings, secretKey, now, release } = options
  let inFlight: Promise<void> | undefined
  const authorizeActor = (actor: AdminActor) => transactionWithRetry(db, (tx) => authorize(tx, actor, 'updates.manage'))
  async function view(): Promise<UpdateStatus> {
    const values = await settings.read(['updates.check', 'updates.state'])
    const state = values['updates.state']
    return {
      enabled: values['updates.check'],
      current: release?.version ?? null,
      deployment: release?.deployment ?? 'source',
      checkedAt: state.checkedAt,
      failure: state.failure,
      latest:
        release && state.latest && compareVersions(state.latest.version, release.version) > 0 ? state.latest : null,
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
        const latest = newerReleases(release.version, result.releases)[0]
        state.checkedAt = at
        state.failure = null
        state.rejected = result.rejected
        state.latest = latest
          ? { version: latest.version, date: latest.date, notes: latest.notes, minNode: latest.minNode }
          : null
        if (latest && !state.notified.includes(latest.version)) {
          await notifyUpdateAvailable(tx, latest.version, at)
          state.notified = [...state.notified, latest.version].slice(-20)
        }
      }
      await tx
        .updateTable('settings')
        .set({
          value: encodeSettingValue('updates.state', state, { secretKey }),
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
  const handler: JobHandler = { run }
  return {
    handler,
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
