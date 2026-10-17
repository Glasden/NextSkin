'use client'

import { Alert, Button, Dialog, DialogClose, Field, Form, Input, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { apiError, formErrors, sendJson } from '../../../lib/api-client'
import { playerNameInputProps, type PlayerNameRules } from '../../../lib/player-name'

export interface RenamePlayerDialogProps {
  pid: number
  name: string
  nameRule: PlayerNameRules
  disabled: boolean
}

export function RenamePlayerDialog({ pid, name, nameRule, disabled }: RenamePlayerDialogProps) {
  const t = useTranslations('user.players')
  const common = useTranslations('common')
  const router = useRouter()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const formId = `rename-player-${pid}`

  async function submit(values: { name?: string }) {
    setPending(true)
    setError(null)
    setErrors({})
    const { status, data } = await sendJson('PATCH', `/api/players/${pid}`, { name: values.name })
    setPending(false)
    if (status === 200) {
      const renamed = (data as { name: string }).name
      if (renamed !== name) toast.show({ tone: 'success', title: t('renamed', { previous: name, name: renamed }) })
      setOpen(false)
      router.refresh()
      return
    }
    const failure = apiError(data)
    if (failure?.fields) setErrors(formErrors(failure))
    else setError(failure?.message ?? t('failed'))
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setError(null)
          setErrors({})
        }
      }}
      trigger={
        <Button size="sm" disabled={disabled}>
          {t('rename')}
        </Button>
      }
      title={t('renameTitle', { name })}
      description={t('renameHint')}
      actions={
        <>
          <DialogClose>{common('cancel')}</DialogClose>
          <Button type="submit" form={formId} variant="primary" loading={pending}>
            {t('rename')}
          </Button>
        </>
      }
    >
      <Form id={formId} errors={errors} onFormSubmit={(values) => void submit(values)}>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label={t('name')} name="name" description={t('nameHint', nameRule)}>
          <Input {...playerNameInputProps(nameRule)} defaultValue={name} />
        </Field>
      </Form>
    </Dialog>
  )
}

export interface DeletePlayerDialogProps {
  pid: number
  name: string
  /** 删除后退还的积分：开着 score.refundOnDelete 时是角色的 score_paid，否则是 0 */
  refund: number
  disabled: boolean
}

export function DeletePlayerDialog({ pid, name, refund, disabled }: DeletePlayerDialogProps) {
  const t = useTranslations('user.players')
  const common = useTranslations('common')
  const router = useRouter()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)

  async function remove() {
    setPending(true)
    const { status, data } = await sendJson('DELETE', `/api/players/${pid}`)
    setPending(false)
    setOpen(false)
    if (status === 200) {
      const { refunded } = data as { refunded: number }
      toast.show({
        tone: 'success',
        title: refunded > 0 ? t('deletedRefund', { name, refund: refunded }) : t('deleted', { name }),
      })
    } else {
      toast.show({ tone: 'danger', title: apiError(data)?.message ?? t('failed') })
    }
    router.refresh()
  }

  return (
    <Dialog
      alert
      open={open}
      onOpenChange={setOpen}
      // 卡片上的按钮只是打开确认框，不可逆的那一步才用 danger（DESIGN.md §6）
      trigger={
        <Button size="sm" disabled={disabled}>
          {t('delete')}
        </Button>
      }
      title={t('deleteTitle', { name })}
      description={refund > 0 ? t('deleteRefund', { refund }) : t('deleteNoRefund')}
      actions={
        <>
          <DialogClose>{common('cancel')}</DialogClose>
          <Button variant="danger" loading={pending} onClick={() => void remove()}>
            {t('deleteConfirm')}
          </Button>
        </>
      }
    />
  )
}
