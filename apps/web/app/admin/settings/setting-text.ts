import type { SettingControl, SettingSection, SettingView } from '@nextskin/domain'

// 服务端组件（页面、审计表）和客户端的表单共用，不能放在 'use client' 的文件里

/**
 * 一个设置项的文案。按键名嵌套在 admin.settings.fields 下（ADR-0028），键名带点号、选项值不固定，
 * 用 next-intl 的类型化取法写不出来，所以由服务端取出原文交给表单。都是纯文本，没有 ICU 参数
 */
export interface SettingText {
  label: string
  help?: string
  options?: Record<string, string>
  fields?: Record<string, SettingText>
  generateHint?: string
}

/** 核心的设置项，或者插件的设置项（ADR-0033：插件的设置页复用这个表单） */
export interface SettingItem extends Omit<SettingView, 'key'> {
  key: string
  text: SettingText
  /** 机密项的“清除”恢复成它；插件的设置传 null，表示删掉这一项、回到插件的默认值 */
  defaultValue: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function toText(entry: unknown, fallback: string): SettingText {
  if (!isRecord(entry)) return { label: fallback }
  return {
    label: string(entry.label) ?? fallback,
    help: string(entry.help),
    options: isRecord(entry.options)
      ? Object.fromEntries(
          Object.entries(entry.options).filter((option): option is [string, string] => typeof option[1] === 'string'),
        )
      : undefined,
    fields: isRecord(entry.fields)
      ? Object.fromEntries(Object.entries(entry.fields).map(([name, field]) => [name, toText(field, name)]))
      : undefined,
    generateHint: string(entry.generateHint),
  }
}

/** fields 是 `t.raw('fields')`；找不到文案时标签退回键名（文案测试守着，不该发生） */
export function settingText(fields: unknown, key: string): SettingText {
  return toText(
    key.split('.').reduce<unknown>((node, part) => (isRecord(node) ? node[part] : undefined), fields),
    key,
  )
}

export function settingsHref(section: SettingSection): string {
  return `/admin/settings/${section}`
}

/**
 * 审计记录里的设置值写成一行字：开关写“开启”“关闭”，枚举写选项的文案，对象逐个属性列出，
 * 站点图片写 hash 的开头几位、没上传时写“默认图形”。control 为 null 时（这一项后来从注册表里删掉了）按 JSON 原样显示
 */
export function formatSettingValue(
  value: unknown,
  control: SettingControl | null,
  text: SettingText,
  words: {
    checked: string
    unchecked: string
    empty: string
    defaultImage: string
    number: (value: number) => string
  },
): string {
  if (control?.kind === 'boolean' && typeof value === 'boolean') return value ? words.checked : words.unchecked
  if (control?.kind === 'image') return typeof value === 'string' ? `${value.slice(0, 8)}…` : words.defaultImage
  if (control?.kind === 'select' && typeof value === 'string') return text.options?.[value] ?? value
  if (control?.kind === 'object' && isRecord(value))
    return control.properties
      .map(({ name, control: property }) => {
        const field = text.fields?.[name] ?? { label: name }
        return `${field.label} ${formatSettingValue(value[name], property, field, words)}`
      })
      .join(' · ')
  if (typeof value === 'number') return words.number(value)
  if (typeof value === 'string') return value === '' ? words.empty : value
  if (Array.isArray(value)) return value.length ? value.join(', ') : words.empty
  return JSON.stringify(value) ?? words.empty
}
