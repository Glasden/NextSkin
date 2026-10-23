import { insertOrIgnore, type CoreDatabase, type IsoTimestamp } from '@nextskin/db'
import type { Transaction } from 'kysely'
import { decodeSettingValue, encodeSettingValue } from './codec.ts'
import { coreSettingsNamespace, coreSettingsRegistry, type CoreSettingKey } from './registry.ts'

/** 后台读取坏值时用默认值兜底，仍保留 unreadable，让管理员能修复存储。 */
export function storedValue(key: CoreSettingKey, stored: string | undefined, secretKey: string) {
  const fallback = coreSettingsRegistry[key].schema.parse(coreSettingsRegistry[key].default)
  try {
    return { value: stored === undefined ? fallback : decodeSettingValue(key, stored, secretKey), unreadable: false }
  } catch {
    return { value: fallback, unreadable: true }
  }
}

export function deleteSetting(tx: Transaction<CoreDatabase>, key: CoreSettingKey) {
  return tx.deleteFrom('settings').where('namespace', '=', coreSettingsNamespace).where('key', '=', key).execute()
}

/**
 * 读改前的值之前先锁住这一行，两个人同时保存同一项时排队，审计里的旧值才是真的旧值。
 * 还没有这一行（值等于默认值）时插一行默认值占位：并发的另一笔插入会在这里等对方提交。
 * 占位的行最后要么被新值覆盖，要么删掉，表里仍然只存和默认值不同的项
 */
export async function lockSetting(
  tx: Transaction<CoreDatabase>,
  key: CoreSettingKey,
  timestamp: IsoTimestamp,
  secretKey: string,
) {
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
