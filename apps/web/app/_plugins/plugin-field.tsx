'use client'

import { Checkbox, Field, Input, Select, Textarea } from '@nextskin/ui'
import { useId } from 'react'
import type { PluginFieldText } from './types'

export type PluginFieldValue = string | boolean

export function initialFieldValue(field: PluginFieldText, value?: unknown): PluginFieldValue {
  if (field.type === 'boolean') return value === true
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return field.type === 'select' && field.required ? (field.options?.[0]?.value ?? '') : ''
}

/** 提交的 JSON 里的值：数字字段转成数字，空着的数字字段不提交 */
export function fieldPayload(fields: readonly PluginFieldText[], values: Readonly<Record<string, PluginFieldValue>>) {
  const payload: Record<string, string | number | boolean> = {}
  for (const field of fields) {
    const value = values[field.name]
    if (value === undefined) continue
    if (field.type === 'number') {
      if (typeof value === 'string' && value.trim() !== '') payload[field.name] = Number(value)
    } else payload[field.name] = value
  }
  return payload
}

/**
 * 插件声明的一个表单字段（SDK 的 Field），用本站的表单控件渲染（DESIGN.md §11）。受控组件：
 * 注册表单、插件的表单页和操作的弹窗各自保存值。`name` 是 Form 按字段返回错误时用的名字
 */
export function PluginField({
  field,
  name,
  value,
  error,
  onChange,
}: {
  field: PluginFieldText
  name: string
  value: PluginFieldValue
  error?: string
  onChange: (value: PluginFieldValue) => void
}) {
  const helpId = useId()
  const text = typeof value === 'string' ? value : ''
  switch (field.type) {
    case 'boolean':
      return (
        <div className="flex flex-col gap-1">
          <Checkbox
            name={name}
            checked={value === true}
            required={field.required}
            onCheckedChange={(checked) => onChange(checked)}
            aria-describedby={field.help ? helpId : undefined}
          >
            {field.label}
          </Checkbox>
          {field.help && (
            <p id={helpId} className="pl-8 text-sm text-pretty text-text-muted">
              {field.help}
            </p>
          )}
          {error && <p className="pl-8 text-sm text-danger">{error}</p>}
        </div>
      )
    case 'select':
      return (
        <Field label={field.label} name={name} nativeLabel={false} description={field.help} error={error}>
          <Select
            options={field.options ?? []}
            value={text}
            required={field.required}
            onValueChange={(next) => onChange(next)}
          />
        </Field>
      )
    case 'textarea':
      return (
        <Field label={field.label} name={name} description={field.help} error={error}>
          <Textarea
            rows={5}
            required={field.required}
            maxLength={field.maxLength}
            placeholder={field.placeholder}
            value={text}
            onValueChange={(next) => onChange(next)}
          />
        </Field>
      )
    default:
      return (
        <Field label={field.label} name={name} description={field.help} error={error}>
          <Input
            type={field.type === 'number' ? 'number' : field.type === 'password' ? 'password' : 'text'}
            inputMode={field.type === 'number' ? 'decimal' : undefined}
            step={field.type === 'number' ? 'any' : undefined}
            autoComplete={field.type === 'password' ? 'new-password' : 'off'}
            required={field.required}
            maxLength={field.type === 'number' ? undefined : field.maxLength}
            placeholder={field.placeholder}
            value={text}
            onValueChange={(next) => onChange(next)}
          />
        </Field>
      )
  }
}
