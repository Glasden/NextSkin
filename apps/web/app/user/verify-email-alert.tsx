'use client'

import { Alert } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { ResendVerificationButton } from './resend-verification-button'

/** 开着“必须验证邮箱”、邮箱还没验证时显示（ADR-0018） */
export function VerifyEmailAlert({ email, mailConfigured }: { email: string; mailConfigured: boolean }) {
  const t = useTranslations('user.verifyEmail')
  return (
    <Alert tone="warning" title={t('title')}>
      <div className="flex flex-col items-start gap-3">
        <p>{mailConfigured ? t('description', { email }) : t('mailNotConfigured')}</p>
        {mailConfigured && <ResendVerificationButton email={email} />}
      </div>
    </Alert>
  )
}
