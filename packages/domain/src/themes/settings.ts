import { isDeepStrictEqual } from 'node:util'
import { upsert, type CoreDatabase, type IsoTimestamp } from '@nextskin/db'
import type { Actor } from '@nextskin/plugin-sdk'
import type { Transaction } from 'kysely'
import { audit } from '../audit/write.ts'
import { encodeSettingValue } from '../settings/codec.ts'
import { coreSettingsNamespace, coreSettingsRegistry } from '../settings/registry.ts'
import { deleteSetting, lockSetting, storedValue } from '../settings/write.ts'

export interface ThemeSettings {
  default: string
  enabled: string[]
}
const keys = ['theme.default', 'theme.enabled'] as const

/** 两行始终按同一顺序锁住，后台修改和卸载共用。 */
export async function lockThemeSettings(tx: Transaction<CoreDatabase>, timestamp: IsoTimestamp, secretKey: string) {
  for (const key of keys) await lockSetting(tx, key, timestamp, secretKey)
  const rows = await tx
    .selectFrom('settings')
    .select(['key', 'value'])
    .where('namespace', '=', coreSettingsNamespace)
    .where('key', 'in', keys)
    .execute()
  const before = {
    default: storedValue('theme.default', rows.find((row) => row.key === 'theme.default')?.value, secretKey),
    enabled: storedValue('theme.enabled', rows.find((row) => row.key === 'theme.enabled')?.value, secretKey),
  }
  return {
    values: { default: before.default.value as string, enabled: before.enabled.value as string[] },
    async save(values: ThemeSettings, actor: Actor, ip: string | null) {
      for (const key of keys) {
        const field = key === 'theme.default' ? 'default' : 'enabled'
        const value = values[field]
        const previous = before[field]
        const changed = previous.unreadable || !isDeepStrictEqual(previous.value, value)
        if (isDeepStrictEqual(value, coreSettingsRegistry[key].default)) await deleteSetting(tx, key)
        else if (changed)
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
        if (changed)
          await audit(tx, {
            actor,
            action: 'setting.update',
            subject: { type: 'setting', id: 0 },
            details: {
              key,
              from: previous.unreadable ? null : previous.value,
              to: value,
              ...(previous.unreadable ? { unreadable: true } : {}),
            },
            ip,
            now: timestamp,
          })
      }
    },
  }
}
