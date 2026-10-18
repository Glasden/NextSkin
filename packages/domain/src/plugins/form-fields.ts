import type { ExtraFields } from '@nextskin/plugin-sdk'
import { DomainError } from '../errors.ts'
import type { PluginFormField } from './system.ts'

/** 不写 maxLength 的文本字段最多这么长：值会写进每个订阅者的事件载荷 */
const DEFAULT_MAX_LENGTH = 1000

/** 表单字段的出错键：`<插件 id>.<字段名>`，和注册表单里的 name 一致 */
export const pluginFieldKey = (pluginId: string, name: string) => `${pluginId}.${name}`

/**
 * 校验插件加在注册表单上的字段，按插件分好。值一律是字符串（SDK 的 ExtraFields）。
 * 表单提交时插件可能刚好停用了：没有对应字段的值直接丢掉
 */
export function collectPluginFields(
  fields: readonly PluginFormField[],
  input: Readonly<Record<string, unknown>> | undefined,
): Map<string, ExtraFields> {
  const extra = new Map<string, Record<string, string>>()
  const invalid: string[] = []
  for (const { pluginId, field } of fields) {
    const values = input?.[pluginId]
    const raw = values && typeof values === 'object' ? (values as Record<string, unknown>)[field.name] : undefined
    const key = pluginFieldKey(pluginId, field.name)
    let value: string | undefined
    if (field.type === 'boolean') {
      if (raw !== undefined && typeof raw !== 'boolean') invalid.push(key)
      else value = raw === true ? 'true' : 'false'
      if (field.required && raw !== true) invalid.push(key)
    } else {
      if (raw !== undefined && raw !== null && typeof raw !== 'string' && typeof raw !== 'number') {
        invalid.push(key)
        continue
      }
      const text = raw === undefined || raw === null ? '' : String(raw).trim()
      if (!text) {
        if (field.required) invalid.push(key)
        continue
      }
      if ([...text].length > (field.maxLength ?? DEFAULT_MAX_LENGTH) || text.includes('\0')) invalid.push(key)
      else if (field.type === 'number' && !Number.isFinite(Number(text))) invalid.push(key)
      else if (field.type === 'select' && !field.options?.some((option) => option.value === text)) invalid.push(key)
      else value = text
    }
    if (value === undefined) continue
    let own = extra.get(pluginId)
    if (!own) extra.set(pluginId, (own = {}))
    own[field.name] = value
  }
  if (invalid.length) throw new DomainError('invalid_request', undefined, [...new Set(invalid)])
  return extra
}
