import { z } from 'zod'
import type { PluginManifest } from '@nextskin/plugin-sdk'

export type JsonSchema = z.core.JSONSchema.JSONSchema

export type SettingControl =
  | { kind: 'boolean' }
  | { kind: 'number'; integer: boolean; min: number | null; max: number | null }
  | { kind: 'text'; format: 'url' | 'email' | null; required: boolean; maxLength: number | null }
  | { kind: 'markdown'; maxLength: number | null }
  | { kind: 'select'; options: readonly string[] }
  | { kind: 'lines' }
  | { kind: 'object'; properties: readonly { name: string; control: SettingControl }[] }
  | { kind: 'secret'; multiline: boolean }

/** 从 JSON Schema 得到控件；映射不了返回 null。核心设置和插件共用。 */
export function settingControl(schema: JsonSchema): SettingControl | null {
  const branches = schema.anyOf
  if (schema.writeOnly === true) {
    const string =
      schema.type === 'string' ||
      (Array.isArray(schema.type) &&
        schema.type.length === 2 &&
        schema.type.includes('string') &&
        schema.type.includes('null')) ||
      (branches?.length === 2 &&
        branches.some((branch) => branch.type === 'null') &&
        branches.some((branch) => branch.type === 'string'))
    return string ? { kind: 'secret', multiline: schema.contentMediaType === 'application/x-pem-file' } : null
  }
  if (branches?.length === 2 && branches.some((branch) => branch.const === '')) {
    const formatted = branches.find((branch) => branch.type === 'string' && typeof branch.format === 'string')
    if (formatted) {
      const control = settingControl(formatted)
      if (control?.kind === 'text') return { ...control, required: false }
    }
    return null
  }
  if (schema.const !== undefined || branches || schema.oneOf || schema.allOf || schema.$ref || schema.not) return null
  if (schema.enum) {
    return schema.enum.every((value) => typeof value === 'string') ? { kind: 'select', options: schema.enum } : null
  }
  switch (schema.type) {
    case 'boolean':
      return { kind: 'boolean' }
    case 'integer':
    case 'number':
      return {
        kind: 'number',
        integer: schema.type === 'integer',
        min: schema.minimum === -Number.MAX_SAFE_INTEGER ? null : (schema.minimum ?? null),
        max: schema.maximum === Number.MAX_SAFE_INTEGER ? null : (schema.maximum ?? null),
      }
    case 'string':
      if (schema.contentMediaType === 'text/markdown') return { kind: 'markdown', maxLength: schema.maxLength ?? null }
      return {
        kind: 'text',
        format: schema.format === 'uri' ? 'url' : schema.format === 'email' ? 'email' : null,
        required: (schema.minLength ?? 0) >= 1,
        maxLength: schema.maxLength ?? null,
      }
    case 'array':
      return schema.items &&
        typeof schema.items === 'object' &&
        !Array.isArray(schema.items) &&
        schema.items.type === 'string'
        ? { kind: 'lines' }
        : null
    case 'object': {
      if (!schema.properties) return null
      const properties: { name: string; control: SettingControl }[] = []
      for (const [name, property] of Object.entries(schema.properties)) {
        const control = typeof property === 'boolean' ? null : settingControl(property)
        if (!control || control.kind === 'object' || control.kind === 'secret') return null
        properties.push({ name, control })
      }
      return { kind: 'object', properties }
    }
    default:
      return null
  }
}

export interface PluginSettingProperty {
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
export function settingProperties(manifest: Pick<PluginManifest, 'id' | 'settingsSchema'>): PluginSettingProperty[] {
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
