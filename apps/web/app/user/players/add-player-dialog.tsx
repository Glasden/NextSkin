'use client'

import { Alert, Button, Dialog, DialogClose, Field, Form, Input, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { apiError, formErrors, sendJson } from '../../../lib/api-client'
import { playerNameInputProps, type PlayerNameRules } from '../../../lib/player-name'

export interface AddPlayerDialogProps {
  /** 添加一个角色要多少积分（score.perPlayer） */
  cost: number
  score: number
  nameRule: PlayerNameRules
  /** 需要先验证邮箱，或者角色已经达到上限（ADR-0043） */
  disabled: boolean
}

export function AddPlayerDialog({ cost, score, nameRule, disabled }: AddPlayerDialogProps) {
  const t = useTranslations('user.players')
  const common = useTranslations('common')
  const router = useRouter()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  // 服务端照样检查；这里提前说明，免得填完名字才知道积分不够
  const insufficient = cost > score

  async function submit(values: { name?: string }) {
    setPending(true)
    setError(null)
    setErrors({})
    const { status, data } = await sendJson('POST', '/api/players', { name: values.name })
    setPending(false)
    if (status === 201) {
      toast.show({ tone: 'success', title: t('added', { name: (data as { name: string }).name }) })
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
        <Button variant="primary" disabled={disabled}>
          {t('add')}
        </Button>
      }
      title={t('add')}
      description={cost > 0 ? t('cost', { cost, score }) : t('free')}
      actions={
        <>
          <DialogClose>{common('cancel')}</DialogClose>
          <Button type="submit" form="add-player" variant="primary" loading={pending} disabled={insufficient}>
            {t('add')}
          </Button>
        </>
      }
    >
      <Form id="add-player" errors={errors} onFormSubmit={(values) => void submit(values)}>
        {insufficient && <Alert tone="warning">{t('insufficient', { cost, score })}</Alert>}
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label={t('name')} name="name" description={t('nameHint', nameRule)}>
          <Input {...playerNameInputProps(nameRule)} />
        </Field>
      </Form>
    </Dialog>
  )
}
