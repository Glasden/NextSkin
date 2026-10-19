'use client'

import { Alert, Button, Dialog, DialogClose, Form, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useState, type ReactElement, type ReactNode } from 'react'
import { apiError } from '../../../../lib/api-client'

export interface ActionDialogProps {
  /** 表单的 id，确认按钮靠它提交表单；一页上不能重复 */
  id: string
  trigger: ReactElement
  title: string
  /** 写明后果（DESIGN.md §7） */
  description?: ReactNode
  confirm: string
  /** 不可逆的操作：确认按钮用 danger，对话框是 alert（点外面不关闭） */
  danger?: boolean
  /** 对话框打开时调用，用来重置受控的输入 */
  onOpen?: () => void
  /** 发请求。values 是表单里各个 Field 的值；受控的输入由调用方自己读 */
  send: (values: Record<string, unknown>) => Promise<{ status: number; data: unknown }>
  /** 请求成功（200）之后的 Toast 标题 */
  done: (data: unknown) => string
  /** 成功之后另做的事；不传时刷新页面 */
  after?: (data: unknown) => void
  /** 表单里的字段名。接口的字段错误挂在这些字段下，其余的显示在表单顶部 */
  fields?: readonly string[]
  /** 接口的字段名和表单不同时的对应，例如收回账号的新邮箱：接口按全局规则把邮箱错误挂在 email 下 */
  rename?: Readonly<Record<string, string>>
  /** 表单的内容 */
  children?: ReactNode
}

/**
 * 用户详情页上的一个操作：确认框加表单，成功后用 Toast 报告结果并刷新页面（ADR-0036"页面"）。
 * 错误文案由接口按请求的语言给出，后台的路径用对管理员说话的 admin.errors
 */
export function ActionDialog({
  id,
  trigger,
  title,
  description,
  confirm,
  danger = false,
  onOpen,
  send,
  done,
  after,
  fields = [],
  rename = {},
  children,
}: ActionDialogProps) {
  const admin = useTranslations('admin')
  const common = useTranslations('common')
  const router = useRouter()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  async function submit(values: Record<string, unknown>) {
    setPending(true)
    setError(null)
    setErrors({})
    const { status, data } = await send(values)
    setPending(false)
    if (status === 200) {
      setOpen(false)
      toast.show({ tone: 'success', title: done(data) })
      if (after) after(data)
      else router.refresh()
      return
    }
    const failure = apiError(data)
    const entries = Object.entries(failure?.fields ?? {}).map(([name, field]): [string, string] => [
      rename[name] ?? name,
      field.message,
    ])
    const known = entries.filter(([name]) => fields.includes(name))
    setErrors(Object.fromEntries(known))
    if (!known.length || known.length < entries.length) setError(failure?.message ?? admin('failed'))
  }

  return (
    <Dialog
      alert={danger}
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setError(null)
          setErrors({})
          onOpen?.()
        }
      }}
      trigger={trigger}
      title={title}
      description={description}
      actions={
        <>
          <DialogClose>{common('cancel')}</DialogClose>
          <Button type="submit" form={id} variant={danger ? 'danger' : 'primary'} loading={pending}>
            {confirm}
          </Button>
        </>
      }
    >
      <Form id={id} errors={errors} onFormSubmit={(values) => void submit(values)}>
        {error && <Alert tone="danger">{error}</Alert>}
        {children}
      </Form>
    </Dialog>
  )
}
