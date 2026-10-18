/**
 * 插件的设置：存在 `settings` 表里，namespace 是 `plugin:<id>`，一个顶层键一行（docs/schema.md）。
 *
 * 表单由 manifest 里的 JSON Schema 生成，和核心设置页是同一套控件（ADR-0028）；
 * 标了 `writeOnly` 的是机密项，加密存储，值不回传到浏览器。
 */
import { isDeepStrictEqual } from 'node:util'
import { toIsoTimestamp, upsert, type CoreDatabase } from '@nextskin/db'
import type { Json, PluginManifest } from '@nextskin/plugin-sdk'
import type { Kysely, Transaction } from 'kysely'
import { z } from 'zod'
import { DomainError } from '../errors.ts'
import { decryptSettingJson, encryptSettingJson } from '../settings/codec.ts'
import { settingControl, type JsonSchema, type SettingControl } from '../settings/form.ts'

export const pluginSettingsNamespace = (pluginId: string) => `plugin:${pluginId}`

export interface PluginSettingView {
  key: string
  control: SettingControl
  /** 机密项没有这一项，只有 isSet */
  value?: unknown
  isSet?: boolean
  /** 存着的值读不出来（密钥换了、格式坏了）：表单显示默认值，保存一次就修好 */
  unreadable: boolean
}

interface Property {
  key: string
  schema: JsonSchema
  secret: boolean
  control: SettingControl
  /** JSON Schema 校验：从 manifest 的 JSON Schema 还原出来的 zod schema */
  validator: z.ZodType
}

/** schema 里顶层以下的地方有没有标 writeOnly（例如 `z.array(secret())`） */
function nestedWriteOnly(value: unknown, top: boolean): boolean {
  if (Array.isArray(value)) return value.some((item) => nestedWriteOnly(item, false))
  if (typeof value !== 'object' || value === null) return false
  if (!top && (value as { writeOnly?: unknown }).writeOnly === true) return true
  return Object.values(value).some((item) => nestedWriteOnly(item, false))
}

/**
 * manifest 的设置 schema 拆成一项一项；映射不了控件的项在插件加载时就报错，不在页面上兜底。
 * 机密只能是顶层的一项：加密和不回传都按顶层的键做，嵌在对象、数组里的 secret() 会被当成普通值明文存储、显示和记进审计
 */
export function settingProperties(manifest: Pick<PluginManifest, 'id' | 'settingsSchema'>): Property[] {
  const schema = manifest.settingsSchema as JsonSchema | null
  if (!schema) return []
  if (schema.type !== 'object' || !schema.properties) throw new Error(`插件 ${manifest.id} 的设置 schema 不是对象`)
  return Object.entries(schema.properties).map(([key, property]) => {
    if (typeof property === 'boolean') throw new Error(`插件 ${manifest.id} 的设置项 ${key} 没有类型`)
    if (nestedWriteOnly(property, true))
      throw new Error(`插件 ${manifest.id} 的设置项 ${key} 里嵌着机密项：机密只能是顶层的一项`)
    const control = settingControl(property)
    if (!control) throw new Error(`插件 ${manifest.id} 的设置项 ${key} 没有对应的控件`)
    const { default: _default, ...rest } = property
    void _default
    return {
      key,
      schema: property,
      secret: property.writeOnly === true,
      control,
      // 默认值由插件自己的 schema 补；这里只校验管理员填的值
      validator: z.fromJSONSchema(rest),
    }
  })
}

export function createPluginSettings(db: Kysely<CoreDatabase>, secretKey: string, now: () => Date) {
  async function rows(executor: Kysely<CoreDatabase>, pluginId: string) {
    return executor
      .selectFrom('settings')
      .select(['key', 'value'])
      .where('namespace', '=', pluginSettingsNamespace(pluginId))
      .execute()
  }

  function decode(pluginId: string, property: Property | undefined, stored: string): Json {
    const json = property?.secret
      ? decryptSettingJson(stored, pluginSettingsNamespace(pluginId), property.key, secretKey)
      : stored
    return JSON.parse(json) as Json
  }

  /** 交给插件的值：机密项已解密。读不出来的项当作没填，插件的 schema 会补默认值或报设置不完整 */
  async function read(pluginId: string, properties: readonly Property[]): Promise<Record<string, Json>> {
    const values: Record<string, Json> = {}
    for (const row of await rows(db, pluginId)) {
      const property = properties.find((item) => item.key === row.key)
      if (!property) continue
      try {
        values[row.key] = decode(pluginId, property, row.value)
      } catch {
        continue
      }
    }
    return values
  }

  return {
    read,
    async view(pluginId: string, properties: readonly Property[]): Promise<PluginSettingView[]> {
      const stored = await rows(db, pluginId)
      return properties.map((property) => {
        const row = stored.find((item) => item.key === property.key)
        let value: unknown = property.schema.default ?? null
        let unreadable = false
        if (row) {
          try {
            value = decode(pluginId, property, row.value)
          } catch {
            unreadable = true
          }
        }
        return {
          key: property.key,
          control: property.control,
          ...(property.secret ? { isSet: row !== undefined && !unreadable } : { value }),
          unreadable,
        }
      })
    },
    /**
     * 校验要改的项；`null` 表示恢复默认（删掉这一行）。先按 JSON Schema 校验每一项，
     * 再把合并后的完整设置交给插件按它自己的 schema 校验（`validate`，一次插件调用），两边都通过才返回。
     * 在事务之外调用：插件调用不能占着数据库的写锁
     */
    async prepare(
      pluginId: string,
      properties: readonly Property[],
      values: Readonly<Record<string, unknown>>,
      validate: (merged: Record<string, Json>) => Promise<{ ok: boolean; fields: readonly string[] }>,
    ): Promise<Map<string, Json | null>> {
      const invalid: string[] = []
      const changes = new Map<string, Json | null>()
      for (const [key, value] of Object.entries(values)) {
        const property = properties.find((item) => item.key === key)
        if (!property) throw new DomainError('invalid_request')
        if (value === null) {
          changes.set(key, null)
          continue
        }
        const result = property.validator.safeParse(value)
        if (!result.success) invalid.push(key)
        else changes.set(key, value as Json)
      }
      if (invalid.length) throw new DomainError('invalid_request', undefined, invalid)
      const merged = await read(pluginId, properties)
      for (const [key, value] of changes) {
        if (value === null) delete merged[key]
        else merged[key] = value
      }
      const verdict = await validate(merged)
      if (!verdict.ok)
        throw new DomainError(
          'invalid_request',
          undefined,
          verdict.fields.length ? verdict.fields : [...changes.keys()],
        )
      return changes
    },
    /** 写入 prepare 过的改动，返回审计要记的项，机密项不带值（ADR-0028）。值没变的项跳过 */
    async write(
      tx: Transaction<CoreDatabase>,
      pluginId: string,
      properties: readonly Property[],
      changes: ReadonlyMap<string, Json | null>,
    ): Promise<{ key: string; secret: boolean; from?: unknown; to?: unknown }[]> {
      const namespace = pluginSettingsNamespace(pluginId)
      // 改前的值在事务里读：两个人同时保存时，审计里的旧值才对得上
      const stored = await rows(tx, pluginId)
      const timestamp = toIsoTimestamp(now())
      const audit: { key: string; secret: boolean; from?: unknown; to?: unknown }[] = []
      for (const [key, value] of changes) {
        const property = properties.find((item) => item.key === key)!
        const row = stored.find((item) => item.key === key)
        let before: Json | null = null
        let readable = true
        if (row) {
          try {
            before = decode(pluginId, property, row.value)
          } catch {
            readable = false
          }
        }
        if (value === null ? !row : row && readable && isDeepStrictEqual(before, value)) continue
        if (value === null) {
          await tx.deleteFrom('settings').where('namespace', '=', namespace).where('key', '=', key).execute()
        } else {
          const json = JSON.stringify(value)
          await upsert(tx, 'settings', {
            values: {
              namespace,
              key,
              value: property.secret ? encryptSettingJson(json, namespace, key, secretKey) : json,
              updated_at: timestamp,
            },
            conflict: ['namespace', 'key'],
            update: ['value', 'updated_at'],
          })
        }
        audit.push(property.secret ? { key, secret: true } : { key, secret: false, from: before, to: value })
      }
      return audit
    },
    /** 卸载时删掉它的全部设置 */
    async clear(tx: Kysely<CoreDatabase>, pluginId: string): Promise<void> {
      await tx.deleteFrom('settings').where('namespace', '=', pluginSettingsNamespace(pluginId)).execute()
    },
  }
}

export type PluginSettings = ReturnType<typeof createPluginSettings>
export type PluginSettingProperty = Property
