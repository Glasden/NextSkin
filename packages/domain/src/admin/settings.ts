import { isDeepStrictEqual } from 'node:util'
import {
  insertOrIgnore,
  toIsoTimestamp,
  transactionWithRetry,
  upsert,
  type CoreDatabase,
  type IsoTimestamp,
} from '@nextskin/db'
import type { Actor } from '@nextskin/plugin-sdk'
import type { Kysely, Transaction } from 'kysely'
import { can, type CorePermission } from '../access/permissions.ts'
import { audit } from '../audit/write.ts'
import { DomainError } from '../errors.ts'
import type { CaptchaInput, CaptchaService } from '../captcha/service.ts'
import type { MailService } from '../mail/service.ts'
import { decodeSettingValue, encodeSettingValue } from '../settings/codec.ts'
import { settingControl, settingJsonSchema, type SettingControl } from '../settings/form.ts'
import {
  coreSettingsNamespace,
  coreSettingsRegistry,
  type CoreSettingKey,
  type CoreSettingValue,
  type SettingSection,
} from '../settings/registry.ts'
import type { createSettingQueries } from '../settings/queries.ts'
import { SITE_IMAGE_MAX_BYTES } from '../site-images/image.ts'
import { siteImageFile, type SiteImageStorage } from '../site-images/storage.ts'
import type { ImagePool } from '../textures/image-pool.ts'
import type { SigningKey } from '../yggdrasil/signing-key.ts'
import type { AdminActor } from './types.ts'

export interface SettingView {
  key: CoreSettingKey
  control: SettingControl
  value?: unknown
  isSet?: boolean
  generate: boolean
  unreadable: boolean
}

function visibleKey(key: string): key is CoreSettingKey {
  return Object.hasOwn(coreSettingsRegistry, key) && coreSettingsRegistry[key as CoreSettingKey].section !== null
}

/** 后台读取坏值时用默认值兜底，仍保留 unreadable，让管理员能修复存储。 */
function storedValue(key: CoreSettingKey, stored: string | undefined, secretKey: string) {
  const fallback = coreSettingsRegistry[key].schema.parse(coreSettingsRegistry[key].default)
  try {
    return { value: stored === undefined ? fallback : decodeSettingValue(key, stored, secretKey), unreadable: false }
  } catch {
    return { value: fallback, unreadable: true }
  }
}

export function createAdminSettings(options: {
  db: Kysely<CoreDatabase>
  settings: ReturnType<typeof createSettingQueries>
  secretKey: string
  production: boolean
  mail: MailService
  captcha: CaptchaService
  getSigningKey: () => Promise<SigningKey | null>
  siteImages: SiteImageStorage
  imagePool: Pick<ImagePool, 'processSiteImage'>
  now: () => Date
  authorize: (
    tx: Transaction<CoreDatabase>,
    actor: AdminActor,
    permission: CorePermission,
  ) => Promise<Extract<Actor, { kind: 'user' }>>
}) {
  const { db, settings, secretKey, production, mail, captcha, getSigningKey, siteImages, imagePool, now, authorize } =
    options
  const keys = Object.keys(coreSettingsRegistry) as CoreSettingKey[]
  const imageKeys = new Set(keys.filter((key) => settingControl(settingJsonSchema(key))?.kind === 'image'))

  function deleteSetting(tx: Transaction<CoreDatabase>, key: CoreSettingKey) {
    return tx.deleteFrom('settings').where('namespace', '=', coreSettingsNamespace).where('key', '=', key).execute()
  }

  /**
   * 读改前的值之前先锁住这一行，两个人同时保存同一项时排队，审计里的旧值才是真的旧值。
   * 还没有这一行（值等于默认值）时插一行默认值占位：并发的另一笔插入会在这里等对方提交。
   * 占位的行最后要么被新值覆盖，要么删掉，表里仍然只存和默认值不同的项
   */
  async function lockSetting(tx: Transaction<CoreDatabase>, key: CoreSettingKey, timestamp: IsoTimestamp) {
    const definition = coreSettingsRegistry[key]
    const placeholder = await insertOrIgnore(
      tx,
      'settings',
      {
        namespace: coreSettingsNamespace,
        key,
        value: encodeSettingValue(key, definition.schema.parse(definition.default), { secretKey }),
        updated_at: timestamp,
      },
      ['namespace', 'key'],
    )
    await tx
      .updateTable('settings')
      .set((eb) => ({ value: eb.ref('value') }))
      .where('namespace', '=', coreSettingsNamespace)
      .where('key', '=', key)
      .execute()
    if (placeholder) return { stored: undefined, placeholder }
    const row = await tx
      .selectFrom('settings')
      .select('value')
      .where('namespace', '=', coreSettingsNamespace)
      .where('key', '=', key)
      .executeTakeFirst()
    return { stored: row?.value, placeholder }
  }

  async function update(actor: AdminActor | null, values: Record<string, unknown>, generated = false) {
    // 站点图片的值要指向存储里已经有的图（ADR-0042"上传和保存"）。在事务之外核对：以后的共享存储是网络请求
    const missingImages = new Set<string>()
    for (const key of imageKeys) {
      const value = Object.hasOwn(values, key) ? values[key] : null
      if (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) && !(await siteImages.has(siteImageFile(value))))
        missingImages.add(key)
    }
    return transactionWithRetry(db, async (tx) => {
      const eventActor: Actor = actor ? await authorize(tx, actor, 'settings.manage') : { kind: 'system' }
      if (Object.keys(values).some((key) => !visibleKey(key))) throw new DomainError('invalid_request')
      const parsed = new Map<CoreSettingKey, CoreSettingValue<CoreSettingKey>>()
      const fields: string[] = []
      for (const key of keys) {
        if (!Object.hasOwn(values, key)) continue
        const definition = coreSettingsRegistry[key]
        const result = definition.schema.safeParse(values[key])
        // 联合注册表的 schema 已验证了 check 所对应的输入类型。
        if (
          !result.success ||
          ('check' in definition && !definition.check(result.data as never)) ||
          missingImages.has(key)
        )
          fields.push(key)
        else parsed.set(key, result.data)
      }
      if (fields.length) throw new DomainError('invalid_request', undefined, fields)
      const updated: CoreSettingKey[] = []
      for (const [key, value] of parsed) {
        const definition = coreSettingsRegistry[key]
        const timestamp = toIsoTimestamp(now())
        const { stored, placeholder } = await lockSetting(tx, key, timestamp)
        const before = storedValue(key, stored, secretKey)
        if (!before.unreadable && isDeepStrictEqual(before.value, value)) {
          if (placeholder) await deleteSetting(tx, key)
          continue
        }
        if (isDeepStrictEqual(value, definition.schema.parse(definition.default))) {
          await deleteSetting(tx, key)
        } else {
          await upsert(tx, 'settings', {
            values: {
              namespace: coreSettingsNamespace,
              key,
              value: encodeSettingValue(key, value, { secretKey }),
              updated_at: timestamp,
            },
            conflict: ['namespace', 'key'],
            update: ['value', 'updated_at'],
          })
        }
        const details = definition.secret
          ? { key, secret: true, ...(generated ? { generated: true } : {}) }
          : settingJsonSchema(key).contentMediaType === 'text/markdown'
            ? {
                key,
                fromLength: before.unreadable ? null : [...(before.value as string)].length,
                toLength: [...(value as string)].length,
                ...(before.unreadable ? { unreadable: true } : {}),
              }
            : {
                key,
                from: before.unreadable ? null : before.value,
                to: value,
                ...(before.unreadable ? { unreadable: true } : {}),
              }
        await audit(tx, {
          actor: eventActor,
          action: 'setting.update',
          subject: { type: 'setting', id: 0 },
          details,
          ip: actor?.ip ?? null,
          now: timestamp,
        })
        updated.push(key)
      }
      return { updated }
    })
  }

  return {
    async settingsSection(section: SettingSection): Promise<SettingView[]> {
      const sectionKeys = keys.filter((key) => coreSettingsRegistry[key].section === section)
      if (!sectionKeys.length) return []
      const rows = await db
        .selectFrom('settings')
        .select(['key', 'value'])
        .where('namespace', '=', coreSettingsNamespace)
        .where('key', 'in', sectionKeys)
        .execute()
      return sectionKeys.map((key) => {
        const definition = coreSettingsRegistry[key]
        const { value, unreadable } = storedValue(key, rows.find((row) => row.key === key)?.value, secretKey)
        const control = settingControl(settingJsonSchema(key))
        if (!control) throw new TypeError(`设置项 ${key} 没有对应的控件`)
        return {
          key,
          control,
          ...(definition.secret ? { isSet: !isDeepStrictEqual(value, definition.default) } : { value }),
          generate: 'generate' in definition,
          unreadable,
        }
      })
    },
    async configChecks(): Promise<{ missing: ('siteUrl' | 'mail' | 'signingKey' | 'captcha')[] }> {
      const missing: ('siteUrl' | 'mail' | 'signingKey' | 'captcha')[] = []
      if (production && !(await settings.read(['site.url']))['site.url']) missing.push('siteUrl')
      if (!(await mail.configured())) missing.push('mail')
      if (!(await getSigningKey())) missing.push('signingKey')
      const values = await settings.read(['captcha.provider', 'captcha.siteKey', 'captcha.secretKey'])
      if (
        values['captcha.provider'] !== 'none' &&
        (!values['captcha.siteKey'].trim() || !values['captcha.secretKey'].trim())
      )
        missing.push('captcha')
      return { missing }
    },
    async disableCaptchaAsSystem(): Promise<{ changed: boolean }> {
      const { updated } = await update(null, { 'captcha.provider': 'none' })
      return { changed: updated.length > 0 }
    },
    async setMaintenanceAsSystem(enabled: boolean): Promise<{ changed: boolean }> {
      const { updated } = await update(null, { 'maintenance.enabled': enabled })
      return { changed: updated.length > 0 }
    },
    async testCaptcha(actor: AdminActor, input: CaptchaInput) {
      await transactionWithRetry(db, (tx) => authorize(tx, actor, 'settings.manage'))
      // 核对在授权事务提交之后，不能占着 SQLite 的写锁等网络。
      return captcha.test(input)
    },
    updateSettings: (actor: AdminActor, values: Record<string, unknown>) => update(actor, values),
    /**
     * 上传站点图片（ADR-0042）：处理完写进存储，返回 hash，不改设置；站长随设置表单保存才生效。
     * bytes 的所有权转给图像 worker
     */
    async uploadSiteImage(actor: AdminActor, bytes: Uint8Array): Promise<{ hash: string }> {
      if (bytes.length > SITE_IMAGE_MAX_BYTES) throw new DomainError('site_image_file_invalid')
      await transactionWithRetry(db, (tx) => authorize(tx, actor, 'settings.manage'))
      const image = await imagePool.processSiteImage({ bytes })
      // 先写白底的那份：有了 <hash>.png 就说明两份都在，保存时只核对它
      await siteImages.write(siteImageFile(image.pixelHash, 'opaque'), image.opaque)
      await siteImages.write(siteImageFile(image.pixelHash), image.png)
      return { hash: image.pixelHash }
    },
    async generateSetting(actor: AdminActor, key: string): Promise<{ updated: CoreSettingKey[] }> {
      const user = await db.selectFrom('users').select('role').where('id', '=', actor.uid).executeTakeFirst()
      if (!user || !can(user.role, 'settings.manage')) throw new DomainError('permission_denied')
      if (!visibleKey(key)) throw new DomainError('invalid_request')
      const definition = coreSettingsRegistry[key]
      if (!('generate' in definition)) throw new DomainError('invalid_request')
      const value = await definition.generate()
      return update(actor, { [key]: value }, true)
    },
    async sendTestMail(actor: AdminActor): Promise<{ to: string }> {
      const user = await transactionWithRetry(db, async (tx) => {
        await authorize(tx, actor, 'settings.manage')
        return tx
          .selectFrom('users')
          .select(['email', 'nickname', 'locale'])
          .where('id', '=', actor.uid)
          .executeTakeFirstOrThrow()
      })
      await mail.sendTest(user)
      return { to: user.email }
    },
  }
}
