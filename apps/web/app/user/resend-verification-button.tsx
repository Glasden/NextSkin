'use client'

import { Button, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { postJson } from '../../lib/api-client'

/** 重新发送验证邮件。走 Better Auth 的接口，回跳地址与注册时发的验证邮件相同（auth/service.ts） */
export function ResendVerificationButton({ email }: { email: string }) {
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
    <Button size="sm" loading={pending} onClick={() => void resend()}>
      {t('resend')}
    </Button>
  )
}
