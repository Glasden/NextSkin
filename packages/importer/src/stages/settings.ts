// 把 settings.ts 算出的设置写进目标库。导入器写的键先全部删掉，再写入和默认值不同的；其余的键是新站自己的配置，保留
import type { CoreDatabase } from '@nextskin/db'
import {
  coreSettingsNamespace,
  coreSettingsRegistry,
  encodeSettingValue,
  isLocale,
  type CoreSettingKey,
  type Locale,
} from '@nextskin/domain/importer'
import type { Transaction } from 'kysely'
import type { StageContext } from '../context.ts'
import { IMPORTED_SETTING_KEYS, type SettingsPlan } from '../settings.ts'

/** 公告和内容政策按站点默认语言挑（site.locale 不由导入器写） */
export async function siteLocale(tx: Transaction<CoreDatabase>): Promise<Locale> {
  const row = await tx
    .selectFrom('settings')
    .select('value')
    .where('namespace', '=', coreSettingsNamespace)
    .where('key', '=', 'site.locale')
    .executeTakeFirst()
  try {
    const value: unknown = row ? JSON.parse(row.value) : null
    if (isLocale(value)) return value
  } catch {
    // 存的值坏了：按默认值
  }
  return coreSettingsRegistry['site.locale'].default
}

export async function writeSettings(ctx: StageContext, plan: SettingsPlan, secretKey: string): Promise<void> {
  const { tx } = ctx
  await tx
    .deleteFrom('settings')
    .where('namespace', '=', coreSettingsNamespace)
    .where('key', 'in', [...IMPORTED_SETTING_KEYS])
    .execute()
  const rows = []
  for (const [key, value] of plan.values) {
    if (JSON.stringify(value) === JSON.stringify(coreSettingsRegistry[key].default)) continue
    rows.push({
      namespace: coreSettingsNamespace,
      key,
      value: encodeSettingValue(key, value as never, { secretKey }),
      updated_at: ctx.now,
    })
  }
  if (rows.length) await tx.insertInto('settings').values(rows).execute()
  ctx.advance('settings', rows.length)
}

export type { CoreSettingKey }
