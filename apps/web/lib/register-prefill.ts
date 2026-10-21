import type { PluginFieldText } from '../app/_plugins/types'

/** 不写 maxLength 的文本字段最多这么长（同 packages/domain 的 form-fields.ts） */
const DEFAULT_FIELD_MAX_LENGTH = 1000

/**
 * 注册页从地址栏预填的值（ADR-0041）：声明了 fromQuery 的字段读查询参数 `<插件 id>.<字段名>`，键也是它。
 * 只是初始值，用户看得到、改得了，提交后照常校验；明显通不过校验的值（选项里没有、不是数字、太长）不预填。
 * 第三方登录的"完成注册"页不调用：参数不经过 OAuth 的往返
 */
export function registerFieldPrefill(
  fields: readonly { pluginId: string; field: PluginFieldText; fromQuery: boolean }[],
  query: Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string> {
  const prefill: Record<string, string> = {}
  for (const { pluginId, field, fromQuery } of fields) {
    if (!fromQuery) continue
    const key = `${pluginId}.${field.name}`
    const raw = query[key]
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim()
    if (!value || value.includes('\0')) continue
    if (field.type === 'select' && !field.options?.some((option) => option.value === value)) continue
    if (field.type === 'number' && !Number.isFinite(Number(value))) continue
    if ([...value].length > (field.maxLength ?? DEFAULT_FIELD_MAX_LENGTH)) continue
    prefill[key] = value
  }
  return prefill
}
