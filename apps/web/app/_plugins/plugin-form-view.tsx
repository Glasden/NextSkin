'use client'

import { Alert, Button, Form, Panel, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { fieldPayload, initialFieldValue, PluginField, type PluginFieldValue } from './plugin-field'
import { callPlugin } from './plugin-request'
import type { PluginFieldText } from './types'

/**
 * 插件的表单页（SDK 的 form 视图）：初始值来自插件的 load 路由，提交给 submit 路由。
 * 提交失败时保留填写的内容（DESIGN.md §7）
 */
export function PluginFormView({
  pluginId,
  label,
  fields,
  initial,
  submit,
}: {
  pluginId: string
  label: string
  fields: readonly PluginFieldText[]
  initial: Readonly<Record<string, unknown>>
  submit: { route: string; method: 'POST' | 'PUT' | 'PATCH'; label: string }
}) {
  const t = useTranslations('pluginView')
  const router = useRouter()
  const toast = useToast()
  const [values, setValues] = useState<Record<string, PluginFieldValue>>(() =>
    Object.fromEntries(fields.map((field) => [field.name, initialFieldValue(field, initial[field.name])])),
  )
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  async function send() {
    setPending(true)
    setFailure(null)
    let result
    try {
      result = await callPlugin(pluginId, submit.method, submit.route, fieldPayload(fields, values))
    } catch {
      result = { ok: false, message: null }
    }
    setPending(false)
    if (!result.ok) {
      setFailure(result.message ? t('failed', { message: result.message }) : t('failedPlain'))
      return
    }
    toast.show({ tone: 'success', title: result.message ?? t('done') })
    router.refresh()
  }

  return (
    <Form aria-label={label} onFormSubmit={() => void send()}>
      <Panel padding="none">
        <div className="flex flex-col gap-5 px-4 py-5 sm:px-6">
          {failure && <Alert tone="danger">{failure}</Alert>}
          {fields.map((field) => (
            <PluginField
              key={field.name}
              field={field}
              name={field.name}
              value={values[field.name] ?? ''}
              onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))}
            />
          ))}
          <div>
            <Button type="submit" variant="primary" loading={pending}>
              {submit.label}
            </Button>
          </div>
        </div>
      </Panel>
    </Form>
  )
}
