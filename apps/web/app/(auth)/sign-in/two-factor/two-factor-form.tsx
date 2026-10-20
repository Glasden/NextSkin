'use client'

import { Alert, Button, Checkbox, Field, Form, Input } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { authErrorCode, postJson } from '../../../../lib/api-client'
import { goToNext } from '../../../../lib/navigation'
import { AuthLink } from '../../auth-link'

type Method = 'totp' | 'backup'

/** 这些错误说明挑战已经作废，只能回去重新输入密码 */
const RESTART = new Set(['INVALID_TWO_FACTOR_COOKIE', 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE'])

export function TwoFactorForm({ next }: { next: string }) {
  const t = useTranslations('auth.twoFactor')
  const router = useRouter()
  const [method, setMethod] = useState<Method>('totp')
  const [trust, setTrust] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<{ message: string; restart: boolean } | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  async function submit(values: { code?: string }) {
    setPending(true)
    setError(null)
    setErrors({})
    const path = method === 'totp' ? '/api/auth/two-factor/verify-totp' : '/api/auth/two-factor/verify-backup-code'
    const { status, data } = await postJson(path, { code: values.code?.trim(), trustDevice: trust })
    if (status === 200) {
      goToNext(router, next)
      return
    }
    setPending(false)
    const code = authErrorCode(data)
    if (code === 'INVALID_CODE') setErrors({ code: t('invalidCode') })
    else if (code === 'INVALID_BACKUP_CODE') setErrors({ code: t('invalidBackupCode') })
    else if (code && RESTART.has(code))
      setError({ message: code === 'INVALID_TWO_FACTOR_COOKIE' ? t('expired') : t('tooManyAttempts'), restart: true })
    else if (code === 'ACCOUNT_TEMPORARILY_LOCKED') setError({ message: t('locked'), restart: false })
    else setError({ message: status === 429 ? t('rateLimited') : t('failed'), restart: false })
  }

  function switchMethod() {
    setMethod(method === 'totp' ? 'backup' : 'totp')
    setError(null)
    setErrors({})
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-pretty text-text-muted">
        {method === 'totp' ? t('description') : t('backupDescription')}
      </p>
      {/* 换方式时换一个表单，清掉已经填的内容 */}
      <Form key={method} errors={errors} onFormSubmit={(values) => void submit(values)}>
        {error && (
          <Alert tone="danger">
            <div className="flex flex-col items-start gap-2">
              <p>{error.message}</p>
              {error.restart && (
                <AuthLink href={`/sign-in?next=${encodeURIComponent(next)}`} next={next}>
                  {t('signInAgain')}
                </AuthLink>
              )}
            </div>
          </Alert>
        )}
        {method === 'totp' ? (
          <Field label={t('code')} name="code">
            <Input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              autoFocus
            />
          </Field>
        ) : (
          <Field label={t('backupCode')} name="code" description={t('backupHint')}>
            <Input autoComplete="off" spellCheck={false} maxLength={32} required autoFocus />
          </Field>
        )}
        <Checkbox checked={trust} onCheckedChange={setTrust}>
          {t('trust')}
        </Checkbox>
        <div className="mt-2">
          <Button type="submit" variant="primary" size="lg" fullWidth loading={pending}>
            {t('submit')}
          </Button>
        </div>
      </Form>
      <div className="flex flex-col items-start gap-3">
        <Button size="sm" onClick={switchMethod}>
          {method === 'totp' ? t('useBackup') : t('useApp')}
        </Button>
        <p className="text-sm text-pretty text-text-muted">{t('lost')}</p>
      </div>
    </div>
  )
}
