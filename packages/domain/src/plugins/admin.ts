/**
 * 后台的插件管理（ADR-0033"安装、升级和卸载"）。第一版先做官方插件：启用、停用、设置、死信。
 * 只有超级管理员能做（`plugins.manage`）：启用插件等于在服务器上运行它的代码。
 */
import { toIsoTimestamp, transactionWithRetry, type CoreDatabase } from '@nextskin/db'
import { highRiskCapabilities, type Capability, type PluginManifest } from '@nextskin/plugin-sdk'
import type { Kysely, Transaction } from 'kysely'
import { can } from '../access/permissions.ts'
import type { AdminActor } from '../admin/types.ts'
import { audit } from '../audit/write.ts'
import { DomainError } from '../errors.ts'
import { deleteDeadLetter, listDeadLetters, retryDeadLetter, type DeadLetter } from '../jobs/store.ts'
import { lockUser } from '../users/lock.ts'
import type { PluginSettingView } from './settings.ts'
import type { PluginSystem } from './system.ts'

export interface PluginSummary {
  id: string
  version: string
  official: boolean
  enabled: boolean
  /** 正在本实例上运行；刚启用、还没切换过来时可能和 enabled 不一致 */
  running: boolean
  lastError: string | null
  deadLetters: number
}

export interface PluginDetail extends PluginSummary {
  manifest: PluginManifest
  /** 安装界面要醒目提示的：高风险能力，以及接触明文密码、第三方身份的 Provider */
  highRisk: readonly string[]
}

const DEAD_LETTER_LIMIT = 50

function highRisk(manifest: PluginManifest): string[] {
  return [
    ...manifest.capabilities.filter((capability) =>
      (highRiskCapabilities as readonly Capability[]).includes(capability),
    ),
    ...(manifest.providers.passwordHasher.length ? ['provider.passwordHasher'] : []),
    ...(manifest.providers.login.length ? ['provider.login'] : []),
  ]
}

export function createPluginAdmin(options: { db: Kysely<CoreDatabase>; plugins: PluginSystem; now: () => Date }) {
  const { db, plugins, now } = options

  async function authorizeRead(actor: AdminActor) {
    const user = await db.selectFrom('users').select('role').where('id', '=', actor.uid).executeTakeFirst()
    if (!user || !can(user.role, 'plugins.manage')) throw new DomainError('permission_denied')
  }

  async function authorize(tx: Transaction<CoreDatabase>, actor: AdminActor) {
    const user = await lockUser(tx, actor.uid)
    if (!can(user.role, 'plugins.manage')) throw new DomainError('permission_denied')
    return { kind: 'user' as const, uid: actor.uid, role: user.role }
  }

  function plugin(id: string) {
    const known = plugins.get(id)
    if (!known) throw new DomainError('plugin_not_found')
    return known
  }

  async function summaries(): Promise<PluginSummary[]> {
    const rows = await db.selectFrom('plugins').selectAll().execute()
    const failed = await db.selectFrom('failed_jobs').select('name').where('name', 'like', 'plugin:%').execute()
    return plugins
      .known()
      .map(({ manifest }) => {
        const row = rows.find((item) => item.id === manifest.id)
        return {
          id: manifest.id,
          version: manifest.version,
          official: true,
          enabled: row?.is_enabled === 1,
          running: plugins.isActive(manifest.id),
          lastError: row?.last_error ?? null,
          deadLetters: failed.filter((job) => job.name.startsWith(`plugin:${manifest.id}:`)).length,
        }
      })
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  async function setEnabled(actor: AdminActor, id: string, enabled: boolean): Promise<void> {
    // 先查权限再查插件：没有权限的人看不出插件存不存在
    await authorizeRead(actor)
    const known = plugin(id)
    const timestamp = () => toIsoTimestamp(now())
    if (enabled) {
      // 迁移在启用之前跑完；它自己分条提交，不在下面的事务里（DDL 在 MySQL 上会隐式提交）
      await transactionWithRetry(db, async (tx) => {
        await authorize(tx, actor)
        const exists = await tx.selectFrom('plugins').select('id').where('id', '=', id).executeTakeFirst()
        // 官方插件第一次启用时才有这一行；第一版授予 manifest 申请的全部能力（docs/schema.md）
        if (!exists)
          await tx
            .insertInto('plugins')
            .values({
              id,
              version: known.manifest.version,
              is_enabled: 0,
              capabilities: JSON.stringify(known.manifest.capabilities),
              package_hash: null,
              last_error: null,
              installed_at: timestamp(),
              updated_at: timestamp(),
            })
            .execute()
      })
      try {
        await plugins.migrate(id, timestamp)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'error'
        await db
          .updateTable('plugins')
          .set({ last_error: [...`migration_failed: ${message}`].slice(0, 500).join(''), updated_at: timestamp() })
          .where('id', '=', id)
          .execute()
        throw new DomainError('plugin_migration_failed')
      }
    }
    await transactionWithRetry(db, async (tx) => {
      const eventActor = await authorize(tx, actor)
      const row = await tx.selectFrom('plugins').select(['is_enabled']).where('id', '=', id).executeTakeFirst()
      if (!row) {
        if (!enabled) return
        throw new DomainError('plugin_not_found')
      }
      if ((row.is_enabled === 1) === enabled) return
      await tx
        .updateTable('plugins')
        .set({
          is_enabled: enabled ? 1 : 0,
          version: known.manifest.version,
          capabilities: JSON.stringify(known.manifest.capabilities),
          ...(enabled ? { last_error: null } : {}),
          updated_at: timestamp(),
        })
        .where('id', '=', id)
        .execute()
      await audit(tx, {
        actor: eventActor,
        action: enabled ? 'plugin.enable' : 'plugin.disable',
        subject: { type: 'plugin', id: 0 },
        details: { plugin: id, version: known.manifest.version },
        ip: actor.ip,
        now: timestamp(),
      })
    })
    await plugins.sync()
  }

  return {
    async list(actor: AdminActor): Promise<PluginSummary[]> {
      await authorizeRead(actor)
      return summaries()
    },
    async detail(actor: AdminActor, id: string): Promise<PluginDetail> {
      await authorizeRead(actor)
      const known = plugin(id)
      const summary = (await summaries()).find((item) => item.id === id)!
      return { ...summary, manifest: known.manifest, highRisk: highRisk(known.manifest) }
    },
    enable: (actor: AdminActor, id: string) => setEnabled(actor, id, true),
    disable: (actor: AdminActor, id: string) => setEnabled(actor, id, false),
    async settings(actor: AdminActor, id: string): Promise<PluginSettingView[]> {
      await authorizeRead(actor)
      const known = plugin(id)
      return plugins.settingsStore.view(id, known.properties)
    },
    /** 先按 JSON Schema 校验，再交给插件按它自己的 schema 校验，两边都通过才保存（ADR-0033） */
    async updateSettings(
      actor: AdminActor,
      id: string,
      values: Record<string, unknown>,
    ): Promise<{ updated: string[] }> {
      await authorizeRead(actor)
      const known = plugin(id)
      const prepared = await plugins.settingsStore.prepare(id, known.properties, values, (merged) =>
        plugins.validateSettings(id, merged),
      )
      return transactionWithRetry(db, async (tx) => {
        const eventActor = await authorize(tx, actor)
        const changes = await plugins.settingsStore.write(tx, id, known.properties, prepared)
        const timestamp = toIsoTimestamp(now())
        for (const change of changes)
          await audit(tx, {
            actor: eventActor,
            action: 'plugin.settings',
            subject: { type: 'plugin', id: 0 },
            // 机密项只记换过了，不记值（ADR-0028）
            details: change.secret
              ? { plugin: id, key: change.key, secret: true }
              : { plugin: id, key: change.key, from: change.from, to: change.to },
            ip: actor.ip,
            now: timestamp,
          })
        return { updated: changes.map((change) => change.key) }
      })
    },
    async deadLetters(actor: AdminActor, id: string): Promise<DeadLetter[]> {
      await authorizeRead(actor)
      plugin(id)
      return listDeadLetters(db, { prefix: `plugin:${id}:`, limit: DEAD_LETTER_LIMIT })
    },
    async retryDeadLetter(actor: AdminActor, id: string, jobId: number): Promise<void> {
      await authorizeRead(actor)
      plugin(id)
      await transactionWithRetry(db, async (tx) => {
        const eventActor = await authorize(tx, actor)
        if (!(await retryDeadLetter(tx, { id: jobId, prefix: `plugin:${id}:`, now: toIsoTimestamp(now()) })))
          throw new DomainError('dead_letter_not_found')
        await audit(tx, {
          actor: eventActor,
          action: 'plugin.deadLetter',
          subject: { type: 'plugin', id: 0 },
          details: { plugin: id, job: jobId, action: 'retry' },
          ip: actor.ip,
          now: toIsoTimestamp(now()),
        })
      })
    },
    async deleteDeadLetter(actor: AdminActor, id: string, jobId: number): Promise<void> {
      await authorizeRead(actor)
      plugin(id)
      await transactionWithRetry(db, async (tx) => {
        const eventActor = await authorize(tx, actor)
        if (!(await deleteDeadLetter(tx, { id: jobId, prefix: `plugin:${id}:` })))
          throw new DomainError('dead_letter_not_found')
        await audit(tx, {
          actor: eventActor,
          action: 'plugin.deadLetter',
          subject: { type: 'plugin', id: 0 },
          details: { plugin: id, job: jobId, action: 'delete' },
          ip: actor.ip,
          now: toIsoTimestamp(now()),
        })
      })
    },
  }
}

export type PluginAdmin = ReturnType<typeof createPluginAdmin>
