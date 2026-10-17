'use client'

import { Alert, Button, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { postJson } from '../../lib/api-client'

/**
 * 开着“必须验证邮箱”、邮箱还没验证时显示（ADR-0018）。重新发送走 Better Auth 的接口，
 * 回跳地址与注册时发的验证邮件相同（auth/service.ts）
 */
export function VerifyEmailAlert({ email, mailConfigured }: { email: string; mailConfigured: boolean }) {
  const t = useTranslations('user.verifyEmail')
  const toast = useToast()
  const [pending, setPending] = useState(false)

  async function resend() {
    setPending(true)
    const { status } = await postJson('/api/auth/send-verification-email', {
      email,
      callbackURL: '/verify-email?status=verified',
    })
    toast.show(
      status === 200
        ? { tone: 'success', title: t('sent') }
        : { tone: 'danger', title: status === 429 ? t('tooManyAttempts') : t('failed') },
    )
    setPending(false)
  }

  return (
    <Alert tone="warning" title={t('title')}>
      <div className="flex flex-col items-start gap-3">
        <p>{mailConfigured ? t('description', { email }) : t('mailNotConfigured')}</p>
        {mailConfigured && (
          <Button size="sm" loading={pending} onClick={() => void resend()}>
            {t('resend')}
          </Button>
        )}
      </div>
    </Alert>
  )
}
