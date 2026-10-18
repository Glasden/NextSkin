'use client'

import { Alert, Button, Dialog, DialogClose, Field, Form, Input } from '@nextskin/ui'
import { useFormatter, useTranslations } from 'next-intl'
import { useState } from 'react'
import { apiError, formErrors, sendJson } from '../../../lib/api-client'

export interface DeleteAccountDialogProps {
  players: number
  oauthClients: number
  score: number
}

/**
 * 删除账号：输入当前密码，确认框写明会一起删掉什么（DESIGN.md §7、ADR-0023）。
 * 成功后会话已经失效，整页跳回首页
 */
export function DeleteAccountDialog({ players, oauthClients, score }: DeleteAccountDialogProps) {
  const t = useTranslations('user.profile.delete')
  const common = useTranslations('common')
  const format = useFormatter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const formId = 'delete-account'

  async function submit(values: { password?: string }) {
    setPending(true)
    setError(null)
    setErrors({})
    const { status, data } = await sendJson('DELETE', '/api/user', { password: values.password })
    if (status === 200) {
      window.location.assign('/')
      return
    }
    setPending(false)
    const failure = apiError(data)
    if (failure?.fields) setErrors(formErrors(failure))
    else setError(failure?.message ?? t('failed'))
  }

  const impact = [
    players > 0 && t('impactPlayers', { count: players }),
    oauthClients > 0 && t('impactOauthClients', { count: oauthClients }),
    score > 0 && t('impactScore', { score: format.number(score) }),
    t('impactSecurity'),
  ].filter((item): item is string => typeof item === 'string')

  return (
    <Dialog
      alert
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setError(null)
          setErrors({})
        }
      }}
      // 打开确认框的按钮不用 danger，不可逆的那一步才用（DESIGN.md §6）
      trigger={<Button>{t('button')}</Button>}
      title={t('dialogTitle')}
      description={t('dialogDescription')}
      actions={
        <>
          <DialogClose>{common('cancel')}</DialogClose>
          <Button type="submit" form={formId} variant="danger" loading={pending}>
            {t('confirm')}
          </Button>
        </>
      }
    >
      <Form id={formId} errors={errors} onFormSubmit={(values) => void submit(values)}>
        {error && <Alert tone="danger">{error}</Alert>}
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-text">
          {impact.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <Field label={t('password')} name="password">
          <Input type="password" autoComplete="current-password" required />
        </Field>
      </Form>
    </Dialog>
  )
}
