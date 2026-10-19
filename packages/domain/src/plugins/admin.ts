/**
 * 后台的插件管理（ADR-0033"安装、升级和卸载"）：官方插件和安装插件的启用、停用、设置、死信，
 * 安装插件的上传、升级和卸载。
 * 只有超级管理员能做（`plugins.manage`）：安装、启用插件等于在服务器上运行它的代码。
 */
import {
  isUniqueViolation,
  toIsoTimestamp,
  transactionWithRetry,
  type CoreDatabase,
  type IsoTimestamp,
} from '@nextskin/db'
import {
  compareVersions,
  PLUGIN_API_VERSION,
  PluginPackageError,
  satisfies,
  sha256Hex,
  unpackPluginPackage,
  type PluginMessages,
} from '@nextskin/plugin-host'
import { highRiskCapabilities, type Capability, type PluginManifest } from '@nextskin/plugin-sdk'
import type { Kysely, Transaction } from 'kysely'
import { can } from '../access/permissions.ts'
import type { AdminActor } from '../admin/types.ts'
import { audit } from '../audit/write.ts'
import { DomainError } from '../errors.ts'
import { isValidCron } from '../jobs/schedules.ts'
import { deleteDeadLetter, listDeadLetters, retryDeadLetter, type DeadLetter } from '../jobs/store.ts'
import { lockUser } from '../users/lock.ts'
import { settingProperties, type PluginSettingView } from './settings.ts'
import type { PluginHostStatus, PluginSystem } from './system.ts'

export interface PluginSummary {
  id: string
  version: string
  official: boolean
  enabled: boolean
  /** 正在本实例上运行；刚启用、还没切换过来、host 不可用时和 enabled 不一致 */
  running: boolean
  lastError: string | null
  deadLetters: number
  /**
   * 上传安装的插件，本实例取不到插件表里这个版本的包（ADR-0033"多实例"）：它在本实例上不可用，
   * 拦截注册的话注册按失败策略关闭。只能停用、卸载，或者等存储恢复
   */
  packageMissing: boolean
}

export interface PluginDetail extends PluginSummary {
  manifest: PluginManifest
  /** 安装界面要醒目提示的：高风险能力，以及接触明文密码、第三方身份的 Provider */
  highRisk: readonly string[]
}

/** 上传插件包之后、确认安装之前展示给管理员的内容 */
export interface PluginPackagePreview {
  /** 确认安装时带回来：确认的必须就是预览的这个包 */
  packageHash: string
  manifest: PluginManifest
  /** 插件包里的文案，按语言放：界面上显示插件的名字、字段和页面的标题 */
  messages: PluginMessages
  highRisk: readonly string[]
  action: 'install' | 'upgrade'
  /** 升级：比旧版本多出来的能力和出站 origin 要重新确认 */
  previous: {
    version: string
    enabled: boolean
    addedCapabilities: readonly string[]
    addedNetwork: readonly string[]
    addedHighRisk: readonly string[]
  } | null
}

const DEAD_LETTER_LIMIT = 50
const MAX_ERROR_LENGTH = 500

function highRisk(manifest: PluginManifest): string[] {
  return [
    ...manifest.capabilities.filter((capability) =>
      (highRiskCapabilities as readonly Capability[]).includes(capability),
    ),
    ...(manifest.providers.passwordHasher.length ? ['provider.passwordHasher'] : []),
    ...(manifest.providers.login.length ? ['provider.login'] : []),
  ]
}

const clip = (text: string) => [...text].slice(0, MAX_ERROR_LENGTH).join('')

export function createPluginAdmin(options: { db: Kysely<CoreDatabase>; plugins: PluginSystem; now: () => Date }) {
  const { db, plugins, now } = options
  const timestamp = (): IsoTimestamp => toIsoTimestamp(now())

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

  async function recordError(id: string, message: string) {
    await db
      .updateTable('plugins')
      .set({ last_error: clip(message), updated_at: timestamp() })
      .where('id', '=', id)
      .execute()
  }

  async function summaries(): Promise<PluginSummary[]> {
    const rows = await db.selectFrom('plugins').selectAll().execute()
    const failed = await db.selectFrom('failed_jobs').select('name').where('name', 'like', 'plugin:%').execute()
    const deadLetters = (id: string) => failed.filter((job) => job.name.startsWith(`plugin:${id}:`)).length
    const known = plugins.known().map(({ manifest, official, local }): PluginSummary => {
      const row = rows.find((item) => item.id === manifest.id)
      return {
        id: manifest.id,
        // 安装插件的版本以插件表为准：本实例取不到新版本的包时，manifest 还是上一个版本的
        version: !official && row ? row.version : manifest.version,
        official,
        enabled: row?.is_enabled === 1,
        running: plugins.isRunning(manifest.id),
        lastError: row?.last_error ?? null,
        deadLetters: deadLetters(manifest.id),
        packageMissing: !official && !local,
      }
    })
    // 本实例从来没取到过包的安装插件也列出来：不然管理员看不到它，也停用、卸载不了它
    const unknown = rows
      .filter((row) => row.package_hash !== null && !plugins.get(row.id))
      .map((row): PluginSummary => ({
        id: row.id,
        version: row.version,
        official: false,
        enabled: row.is_enabled === 1,
        running: false,
        lastError: row.last_error ?? null,
        deadLetters: deadLetters(row.id),
        packageMissing: true,
      }))
    return [...known, ...unknown].sort((a, b) => a.id.localeCompare(b.id))
  }

  /**
   * 锁住 plugins 表的全部行（行数很少）。启用、安装、升级、卸载的事务先锁再读，读到的是最新提交的状态，
   * 并发的同类操作（包括别的实例上的）在这里排队：版本检查、依赖和冲突检查和随后的写入不会被插进来
   */
  async function lockPlugins(tx: Transaction<CoreDatabase>): Promise<void> {
    await tx
      .updateTable('plugins')
      .set((eb) => ({ updated_at: eb.ref('updated_at') }))
      .execute()
  }

  /**
   * 依赖和冲突（ADR-0033"安装"）：requires 里的插件要已经启用、版本满足范围；
   * 和已启用的插件不能互相冲突（任何一方的 conflicts 里写了对方都算）。
   * 启用、升级的提交事务里在 lockPlugins 之后再查一遍，按表里的状态，不按本实例登记的
   */
  async function checkDependencies(executor: Kysely<CoreDatabase>, manifest: PluginManifest): Promise<void> {
    const enabled = new Map(
      (
        await executor
          .selectFrom('plugins')
          .select(['id', 'version', 'package_hash'])
          .where('is_enabled', '=', 1)
          .execute()
      ).map((row) => [row.id, row]),
    )
    for (const [dependency, range] of Object.entries(manifest.requires)) {
      const version = enabled.get(dependency)?.version
      if (version === undefined || !satisfies(version, range))
        throw new DomainError('plugin_requires_unmet', { plugin: dependency, range })
    }
    for (const other of enabled.values()) {
      if (other.id === manifest.id) continue
      if (manifest.conflicts.includes(other.id)) throw new DomainError('plugin_conflict', { plugin: other.id })
      // 对方的 conflicts 在它的 manifest 里：本实例还没同步到它表里的这个版本（别的实例刚升级），就不能按旧的判断
      const found = plugins.get(other.id)
      if (!found || (!found.official && found.local?.hash !== other.package_hash)) throw new DomainError('plugin_busy')
      if (found.manifest.conflicts.includes(manifest.id)) throw new DomainError('plugin_conflict', { plugin: other.id })
    }
  }

  /**
   * 反向依赖：已启用的其他插件的 requires 里有这个插件时，不能停用、卸载它；升级后的版本（version）也要满足它们的范围。
   * 对方的 requires 按本实例上它的 manifest；本实例从来没取到过它的包就不知道，跳过（它在本实例上本来就没有运行）
   */
  async function checkDependents(executor: Kysely<CoreDatabase>, id: string, version: string | null): Promise<void> {
    const enabled = await executor
      .selectFrom('plugins')
      .select('id')
      .where('is_enabled', '=', 1)
      .where('id', '!=', id)
      .execute()
    for (const other of enabled) {
      const range = plugins.get(other.id)?.manifest.requires[id]
      if (range !== undefined && (version === null || !satisfies(version, range)))
        throw new DomainError('plugin_required_by', { plugin: other.id, range })
    }
  }

  /** 解包并校验；升级时和旧版本比较。不写任何东西 */
  async function inspect(bytes: Uint8Array) {
    let unpacked: ReturnType<typeof unpackPluginPackage>
    try {
      unpacked = unpackPluginPackage(bytes)
    } catch (error) {
      if (error instanceof PluginPackageError) throw new DomainError('plugin_package_invalid', { reason: error.code })
      throw error
    }
    const { manifest } = unpacked
    try {
      settingProperties(manifest)
    } catch {
      throw new DomainError('plugin_package_invalid', { reason: 'invalid_settings' })
    }
    // 调度器不认的 cron 要在这里拦下：启用之后才发现，插件就登记不上了
    if (manifest.cron.some((entry) => !isValidCron(entry.schedule)))
      throw new DomainError('plugin_package_invalid', { reason: 'invalid_cron' })
    if (plugins.isOfficial(manifest.id)) throw new DomainError('plugin_id_reserved', { plugin: manifest.id })
    if (!satisfies(PLUGIN_API_VERSION, manifest.api))
      throw new DomainError('plugin_api_incompatible', { api: manifest.api, current: PLUGIN_API_VERSION })
    const row = await db
      .selectFrom('plugins')
      .select(['version', 'is_enabled', 'package_hash'])
      .where('id', '=', manifest.id)
      .executeTakeFirst()
    // 迁移只能往前走，不支持降级，也不能用同一个版本号换内容
    if (row && compareVersions(manifest.version, row.version) <= 0)
      throw new DomainError('plugin_version_not_newer', { installed: row.version })
    for (const [dependency, range] of Object.entries(manifest.requires)) {
      const found = plugins.get(dependency)
      if (!found || !satisfies(found.manifest.version, range))
        throw new DomainError('plugin_requires_unmet', { plugin: dependency, range })
    }
    if (row?.is_enabled === 1) await checkDependencies(db, manifest)
    if (row) await checkDependents(db, manifest.id, manifest.version)
    const old = plugins.get(manifest.id)?.manifest
    const preview: PluginPackagePreview = {
      packageHash: sha256Hex(bytes),
      manifest,
      messages: unpacked.messages,
      highRisk: highRisk(manifest),
      action: row ? 'upgrade' : 'install',
      previous: row
        ? {
            version: row.version,
            enabled: row.is_enabled === 1,
            addedCapabilities: manifest.capabilities.filter((item) => !old?.capabilities.includes(item)),
            addedNetwork: manifest.network.filter((item) => !old?.network.includes(item)),
            addedHighRisk: highRisk(manifest).filter((item) => !old || !highRisk(old).includes(item)),
          }
        : null,
    }
    return { preview, row }
  }

  /** 表里这个插件的包还是 hash：不是就是别人刚改过，按冲突处理 */
  async function assertPackage(id: string, hash: string | null): Promise<void> {
    const row = await db.selectFrom('plugins').select('package_hash').where('id', '=', id).executeTakeFirst()
    if ((row?.package_hash ?? null) !== hash) throw new DomainError('plugin_busy')
  }

  async function setEnabled(actor: AdminActor, id: string, enabled: boolean): Promise<void> {
    // 先查权限再查插件：没有权限的人看不出插件存不存在
    await authorizeRead(actor)
    const known = plugins.get(id)
    // 本实例从来没取到过包的安装插件（ADR-0033"多实例"）只能停用、卸载：不知道它会做什么，不能启用
    if (!known) {
      const row = await db.selectFrom('plugins').select('package_hash').where('id', '=', id).executeTakeFirst()
      if (!row?.package_hash) throw new DomainError('plugin_not_found')
      if (enabled) throw new DomainError('plugin_unavailable')
    }
    // 迁移回滚不了：同一个插件的启用、升级不能在两个实例上同时跑
    await plugins.withLock(id, async () => {
      const current = await db.selectFrom('plugins').select('is_enabled').where('id', '=', id).executeTakeFirst()
      if ((current?.is_enabled === 1) === enabled) return

      /**
       * 改启用状态并写审计；状态已经是目标值时什么也不做。安装插件传 hash：准备好的那一代加载、迁移的是这个包，
       * 这期间被别人升级或卸载了就不启用
       */
      const commit = (hash?: string) =>
        transactionWithRetry(db, async (tx) => {
          const eventActor = await authorize(tx, actor)
          await lockPlugins(tx)
          const row = await tx
            .selectFrom('plugins')
            .select(['version', 'is_enabled', 'package_hash'])
            .where('id', '=', id)
            .executeTakeFirst()
          if (!row) {
            if (!enabled) return
            throw new DomainError('plugin_not_found')
          }
          if ((row.is_enabled === 1) === enabled) return
          if (hash !== undefined && row.package_hash !== hash) throw new DomainError('plugin_busy')
          if (!enabled) await checkDependents(tx, id, null)
          else if (known) await checkDependencies(tx, known.manifest)
          else throw new DomainError('plugin_unavailable')
          await tx
            .updateTable('plugins')
            .set({
              is_enabled: enabled ? 1 : 0,
              // 官方插件随发行包升级：启用时按当前的 manifest 记版本和能力。安装插件的这两项在安装、升级时写
              ...(known?.official
                ? { version: known.manifest.version, capabilities: JSON.stringify(known.manifest.capabilities) }
                : {}),
              ...(enabled ? { last_error: null } : {}),
              updated_at: timestamp(),
            })
            .where('id', '=', id)
            .execute()
          await audit(tx, {
            actor: eventActor,
            action: enabled ? 'plugin.enable' : 'plugin.disable',
            subject: { type: 'plugin', id: 0 },
            details: { plugin: id, version: known?.official ? known.manifest.version : row.version },
            ip: actor.ip,
            now: timestamp(),
          })
        })

      const migrate = async (run: () => Promise<void>) => {
        try {
          await run()
        } catch (error) {
          await recordError(id, `migration_failed: ${error instanceof Error ? error.message : 'error'}`)
          throw new DomainError('plugin_migration_failed')
        }
      }

      if (!enabled) {
        await commit()
        await plugins.sync()
        return
      }
      if (!known) throw new DomainError('plugin_unavailable')
      await checkDependencies(db, known.manifest)
      if (known.official) {
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
        await migrate(() => plugins.migrate(id, timestamp))
        await commit()
        await plugins.sync()
        return
      }
      // 安装插件：先拉起包含它的新一代、在里面跑迁移，加载不了就不启用，当前这一代照常运行（ADR-0033）
      const local = known.local
      if (!local) throw new DomainError('plugin_unavailable')
      try {
        await plugins.stage(local, async (staged) => {
          // 迁移改的是数据库：先确认表里还是这个包，别的实例上的管理员可能刚升级、卸载了它
          await assertPackage(id, local.hash)
          await migrate(() => staged.migrate(timestamp))
          await commit(local.hash)
        })
      } catch (error) {
        if (error instanceof DomainError && error.code === 'plugin_load_failed')
          await recordError(id, `load_failed: ${error.params?.message ?? ''}`)
        throw error
      }
    })
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
    async hostStatus(actor: AdminActor): Promise<PluginHostStatus> {
      await authorizeRead(actor)
      return plugins.hostStatus()
    },
    /** 连续崩溃、停止自动重启之后，管理员确认插件没问题了再手动重启 */
    async restartHost(actor: AdminActor): Promise<void> {
      await authorizeRead(actor)
      await transactionWithRetry(db, async (tx) => {
        const eventActor = await authorize(tx, actor)
        await audit(tx, {
          actor: eventActor,
          action: 'plugin.restartHost',
          subject: { type: 'plugin', id: 0 },
          details: {},
          ip: actor.ip,
          now: timestamp(),
        })
      })
      await plugins.restartHost()
    },
    enable: (actor: AdminActor, id: string) => setEnabled(actor, id, true),
    disable: (actor: AdminActor, id: string) => setEnabled(actor, id, false),

    /** 上传插件包之后的预览：校验通过才返回，什么也不写 */
    async preview(actor: AdminActor, bytes: Uint8Array): Promise<PluginPackagePreview> {
      await authorizeRead(actor)
      return (await inspect(bytes)).preview
    },

    /**
     * 确认安装或升级。浏览器再传一次同一个包，`packageHash` 是预览时拿到的：
     * 多实例部署时预览和确认可能落在不同的实例上，不在服务端暂存上传的包
     */
    async install(
      actor: AdminActor,
      bytes: Uint8Array,
      packageHash: string,
    ): Promise<{ id: string; version: string; action: 'install' | 'upgrade' }> {
      await authorizeRead(actor)
      if (sha256Hex(bytes) !== packageHash) throw new DomainError('plugin_package_changed')
      const { preview, row } = await inspect(bytes)
      const { manifest } = preview
      const id = manifest.id
      const packages = plugins.packages
      if (!packages) throw new DomainError('plugin_unavailable')
      return plugins.withLock(id, async () => {
        // 卸载之后不久又装回来：上次卸载的表和包还没删，先删掉，新版本的迁移才能建表
        if (!row) await plugins.runPendingCleanup(id)
        // 先存进存储接口再改表：别的实例看到新的一行时一定取得到包。改表失败时存储里留下一个没人用的包，
        // 不删：同一个包可能正被另一次安装用着
        const local = await packages.add(bytes)

        /**
         * 写插件表的这一行和审计。上面检查之后这个插件被别人改过（升级、启用、停用、卸载、同时安装）就按冲突处理：
         * 升级走不走准备新一代、跑不跑迁移，是按检查时的状态决定的。浏览器上预览和确认之间的变化不算冲突：
         * 确认时重新检查，按那时的状态安装或升级（新增的能力是和预览时的版本比的，不会比实际少）
         */
        const commit = () =>
          transactionWithRetry(db, async (tx) => {
            const eventActor = await authorize(tx, actor)
            await lockPlugins(tx)
            const current = await tx
              .selectFrom('plugins')
              .select(['version', 'is_enabled', 'package_hash'])
              .where('id', '=', id)
              .executeTakeFirst()
            if (
              (current?.package_hash ?? null) !== (row?.package_hash ?? null) ||
              (current?.is_enabled ?? 0) !== (row?.is_enabled ?? 0)
            )
              throw new DomainError('plugin_busy')
            if (current?.is_enabled === 1) await checkDependencies(tx, manifest)
            if (current) await checkDependents(tx, id, manifest.version)
            const values = {
              version: manifest.version,
              // 第一版授予 manifest 申请的全部能力（docs/schema.md）
              capabilities: JSON.stringify(manifest.capabilities),
              package_hash: preview.packageHash,
              last_error: null,
              updated_at: timestamp(),
            }
            if (current) await tx.updateTable('plugins').set(values).where('id', '=', id).execute()
            else
              await tx
                .insertInto('plugins')
                .values({ id, is_enabled: 0, installed_at: timestamp(), ...values })
                .execute()
            await audit(tx, {
              actor: eventActor,
              action: current ? 'plugin.upgrade' : 'plugin.install',
              subject: { type: 'plugin', id: 0 },
              details: {
                plugin: id,
                version: manifest.version,
                ...(current ? { from: current.version } : {}),
                packageHash: preview.packageHash,
                capabilities: [...manifest.capabilities],
                network: [...manifest.network],
              },
              ip: actor.ip,
              now: timestamp(),
            })
          })

        /** 两个管理员同时第一次安装同一个 id：后插入的那个撞主键 */
        const write = async () => {
          try {
            await commit()
          } catch (error) {
            if (!row && isUniqueViolation(db, error)) throw new DomainError('plugin_busy')
            throw error
          }
        }

        if (row?.is_enabled === 1) {
          // 升级启用中的插件：新版本先在准备切换过去的那一代里加载、跑迁移，都通过了才改表、切换
          try {
            await plugins.stage(local, async (staged) => {
              // 迁移改的是数据库：先确认还是预览时的那个版本，别的实例上的管理员可能刚升级、卸载了它
              await assertPackage(id, row.package_hash)
              try {
                await staged.migrate(timestamp)
              } catch (error) {
                await recordError(id, `migration_failed: ${error instanceof Error ? error.message : 'error'}`)
                throw new DomainError('plugin_migration_failed')
              }
              await write()
            })
          } catch (error) {
            if (error instanceof DomainError && error.code === 'plugin_load_failed')
              await recordError(id, `load_failed: ${error.params?.message ?? ''}`)
            throw error
          }
        } else {
          await write()
          await plugins.sync()
        }
        if (row?.package_hash && row.package_hash !== preview.packageHash)
          await packages.store
            .delete(row.package_hash)
            .catch(() => console.warn(`[plugins] ${id} old_package_delete_failed`))
        return { id, version: manifest.version, action: preview.action }
      })
    },

    /**
     * 卸载安装插件（docs/schema.md、ADR-0033"卸载"）。一个事务里删掉它还没完成的任务、定时任务条目、死信、设置和
     * 插件表的这一行（KV、迁移记录随之级联删除），并登记清理任务；表和存储里的插件包由清理任务稍后删：
     * 各实例停掉它、旧的一代做完在途的调用之后。清理任务在表里，进程中途退出也不会丢。官方插件只能停用
     */
    async uninstall(actor: AdminActor, id: string): Promise<void> {
      await authorizeRead(actor)
      if (plugins.isOfficial(id)) throw new DomainError('plugin_official')
      const prefix = `plugin:${id}:%`
      await plugins.withLock(id, () =>
        transactionWithRetry(db, async (tx) => {
          const eventActor = await authorize(tx, actor)
          await lockPlugins(tx)
          const row = await tx
            .selectFrom('plugins')
            .select(['version', 'package_hash', 'is_enabled'])
            .where('id', '=', id)
            .executeTakeFirst()
          if (!row?.package_hash) throw new DomainError('plugin_not_found')
          await checkDependents(tx, id, null)
          await tx.deleteFrom('jobs').where('name', 'like', prefix).execute()
          await tx.deleteFrom('job_schedules').where('name', 'like', prefix).execute()
          await tx.deleteFrom('failed_jobs').where('name', 'like', prefix).execute()
          await plugins.settingsStore.clear(tx, id)
          await tx.deleteFrom('plugins').where('id', '=', id).execute()
          await plugins.scheduleCleanup(tx, { id, hash: row.package_hash })
          await audit(tx, {
            actor: eventActor,
            action: 'plugin.uninstall',
            subject: { type: 'plugin', id: 0 },
            details: { plugin: id, version: row.version, wasEnabled: row.is_enabled === 1 },
            ip: actor.ip,
            now: timestamp(),
          })
        }),
      )
      // 本实例立即停掉它；别的实例最多 5 秒后跟上
      await plugins.sync()
    },

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
      // 和卸载串行：卸载删了设置之后不能又被写回去
      return plugins.withLock(id, async () => {
        const prepared = await plugins.settingsStore.prepare(id, known.properties, values, (merged) =>
          plugins.validateSettings(id, merged),
        )
        return transactionWithRetry(db, async (tx) => {
          const eventActor = await authorize(tx, actor)
          // 安装插件这时可能已经卸载了（本实例还没同步）；官方插件第一次启用之前没有这一行
          if (!known.official && !(await tx.selectFrom('plugins').select('id').where('id', '=', id).executeTakeFirst()))
            throw new DomainError('plugin_not_found')
          const changes = await plugins.settingsStore.write(tx, id, known.properties, prepared)
          const at = timestamp()
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
              now: at,
            })
          return { updated: changes.map((change) => change.key) }
        })
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
        if (!(await retryDeadLetter(tx, { id: jobId, prefix: `plugin:${id}:`, now: timestamp() })))
          throw new DomainError('dead_letter_not_found')
        await audit(tx, {
          actor: eventActor,
          action: 'plugin.deadLetter',
          subject: { type: 'plugin', id: 0 },
          details: { plugin: id, job: jobId, action: 'retry' },
          ip: actor.ip,
          now: timestamp(),
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
          now: timestamp(),
        })
      })
    },
  }
}

export type PluginAdmin = ReturnType<typeof createPluginAdmin>
