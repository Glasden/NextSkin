'use client'

import { Alert, Button, Link } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import NextLink from 'next/link'
import { useState } from 'react'
import { apiError, postJson } from '../../../lib/api-client'

export function ConfirmEmailForm({ token, email }: { token: string; email: string }) {
  const t = useTranslations('auth.confirmEmail')
  const [pending, setPending] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    setPending(true)
    setError(null)
    const { status, data } = await postJson('/api/user/email/confirm', { token })
    setPending(false)
    if (status === 200) setDone(true)
    else setError(apiError(data)?.message ?? t('failed'))
  }

  if (done)
    return (
      <div className="flex flex-col gap-6">
        <Alert tone="success" title={t('doneTitle')}>
          {t('done', { email })}
        </Alert>
        <p className="text-sm">
          <Link render={<NextLink href="/user/profile" />}>{t('profile')}</Link>
        </p>
      </div>
    )

  return (
    <div className="flex flex-col gap-6">
      {error && <Alert tone="danger">{error}</Alert>}
      <p className="text-base text-pretty text-text">{t('description', { email })}</p>
      <Button variant="primary" size="lg" fullWidth loading={pending} onClick={() => void confirm()}>
        {t('submit')}
      </Button>
    </div>
  )
}
