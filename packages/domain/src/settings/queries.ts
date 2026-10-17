import type { CoreDatabase } from '@nextskin/db'
import type { Kysely } from 'kysely'
import { decodeSettingValue } from './codec.ts'
import { coreSettingsNamespace, coreSettingsRegistry, type CoreSettingKey, type CoreSettings } from './registry.ts'

export function createSettingQueries(db: Kysely<CoreDatabase>, secretKey: string) {
  return {
    async read<K extends CoreSettingKey>(keys: readonly K[]): Promise<Pick<CoreSettings, K>> {
      const values = {} as Pick<CoreSettings, K>
      if (keys.length === 0) return values
      const rows = await db
        .selectFrom('settings')
        .select(['namespace', 'key', 'value'])
        .where('namespace', '=', coreSettingsNamespace)
        .where('key', 'in', keys)
        .execute()
      for (const key of keys) {
        const row = rows.find((row) => row.namespace === coreSettingsNamespace && row.key === key)
        values[key] = (
          row
            ? decodeSettingValue(key, row.value, secretKey)
            : coreSettingsRegistry[key].schema.parse(coreSettingsRegistry[key].default)
        ) as CoreSettings[K]
      }
      return values
    },
  }
}
