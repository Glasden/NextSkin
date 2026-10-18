import { z } from 'zod'
import { coreSettingsRegistry, type CoreSettingKey } from './registry.ts'

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

/** 从 JSON Schema 得到控件；映射不了返回 null。插件 manifest 的 JSON Schema 以后也走这个函数。 */
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

/** 注册表一项的输入 JSON Schema；机密项永远只写。 */
export function settingJsonSchema(key: CoreSettingKey): JsonSchema {
  const definition = coreSettingsRegistry[key]
  const schema = z.toJSONSchema(definition.schema, { io: 'input' })
  return definition.secret ? { ...schema, writeOnly: true } : schema
}
