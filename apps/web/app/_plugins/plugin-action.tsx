'use client'

import { Button, Dialog, DialogClose, Form, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useId, useState } from 'react'
import { fieldPayload, initialFieldValue, PluginField, type PluginFieldValue } from './plugin-field'
import { callPlugin, fillRoute } from './plugin-request'
import type { PluginActionText } from './types'

/**
 * 插件声明的一个操作（SDK 的 Action）：表格上方的工具栏，或者每一行后面。
 * 带表单的先弹表单，带确认的先弹确认框，都没有就直接执行；执行完提示结果并刷新页面上的数据
 */
export function PluginAction({
  pluginId,
  action,
  row,
  rowLabel,
}: {
  pluginId: string
  action: PluginActionText
  /** 行动作：这一行的数据，路径里的 `:字段` 换成它的值 */
  row?: Readonly<Record<string, unknown>>
  /** 行动作的按钮名称，读屏软件分得清是哪一行，例如“删除 ABCD” */
  rowLabel?: string
}) {
  const t = useTranslations('pluginView')
  const common = useTranslations('common')
  const router = useRouter()
  const toast = useToast()
  const formId = useId()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const fields = action.form ?? []
  const [values, setValues] = useState<Record<string, PluginFieldValue>>(() =>
    Object.fromEntries(fields.map((field) => [field.name, initialFieldValue(field)])),
  )
  const danger = action.tone === 'danger'

  async function run() {
    setPending(true)
    setFailure(null)
    const result = await callPlugin(
      pluginId,
      action.method,
      fillRoute(action.route, row),
      fields.length ? fieldPayload(fields, values) : undefined,
    )
    setPending(false)
    if (!result.ok) {
      const message = result.message ? t('failed', { message: result.message }) : t('failedPlain')
      // 弹着表单时把错误留在表单里，填写的内容不丢（DESIGN.md §7）
      if (fields.length) setFailure(message)
      else {
        setOpen(false)
        toast.show({ tone: 'danger', title: message })
      }
      return
    }
    setOpen(false)
    setValues(Object.fromEntries(fields.map((field) => [field.name, initialFieldValue(field)])))
    toast.show({ tone: 'success', title: result.message ?? t('done') })
    router.refresh()
  }

  return (
    <>
      <Button
        size="sm"
        variant={danger ? 'danger' : 'secondary'}
        loading={pending && !open}
        aria-label={rowLabel}
        onClick={() => (fields.length || action.confirm ? setOpen(true) : void run())}
      >
        {action.label}
      </Button>
      {open && (
        <Dialog
          alert={!fields.length}
          open
          onOpenChange={(next) => {
            if (!next) setOpen(false)
          }}
          title={action.label}
          description={action.confirm}
          actions={
            <>
              <DialogClose>{common('cancel')}</DialogClose>
              {fields.length ? (
                <Button type="submit" form={formId} variant={danger ? 'danger' : 'primary'} loading={pending}>
                  {action.label}
                </Button>
              ) : (
                <Button variant={danger ? 'danger' : 'primary'} loading={pending} onClick={() => void run()}>
                  {action.label}
                </Button>
              )}
            </>
          }
        >
          {fields.length > 0 && (
            <Form id={formId} onFormSubmit={() => void run()}>
              {failure && (
                <p role="alert" className="text-sm text-danger">
                  {failure}
                </p>
              )}
              {fields.map((field) => (
                <PluginField
                  key={field.name}
                  field={field}
                  name={field.name}
                  value={values[field.name] ?? ''}
                  onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))}
                />
              ))}
            </Form>
          )}
        </Dialog>
      )}
    </>
  )
}
