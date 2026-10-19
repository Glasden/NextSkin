'use client'

import { Alert, Button, Field, Form, Input, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { apiError, formErrors, postJson } from '../../../lib/api-client'
import { signInAgain } from './reauth'

/**
 * 给没有密码的账号设置密码（ADR-0034）：经第三方登录注册的账号没有密码，设好之后也能用邮箱和密码登录、在启动器里登录。
 * 要求刚登录过，否则先重新登录
 */
export function SetPasswordForm({ min, max }: { min: number; max: number }) {
  const t = useTranslations('user.security.password')
  const signUp = useTranslations('auth.signUp')
  const router = useRouter()
  const toast = useToast()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [reauth, setReauth] = useState(false)

  async function submit(values: { password?: string }) {
    setPending(true)
    setError(null)
    setErrors({})
    const { status, data } = await postJson('/api/user/password', { password: values.password })
    if (status === 200) {
      toast.show({ tone: 'success', title: t('setDone') })
      router.refresh()
      return
    }
    setPending(false)
    const failure = apiError(data)
    if (failure?.code === 'session_not_fresh') setReauth(true)
    else if (failure?.fields) setErrors(formErrors(failure))
    else setError(failure?.message ?? t('setFailed'))
  }

  if (reauth)
    return (
      <Alert tone="warning" title={t('reauthTitle')}>
        <span className="flex flex-col items-start gap-3">
          {t('reauthDescription')}
          <Button
            loading={pending}
            onClick={() => {
              setPending(true)
              void signInAgain()
            }}
          >
            {t('reauth')}
          </Button>
        </span>
      </Alert>
    )

  return (
    <Form errors={errors} onFormSubmit={(values) => void submit(values)}>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('new')} name="password" description={signUp('passwordHint', { min, max })}>
          <Input type="password" autoComplete="new-password" required minLength={min} maxLength={max} />
        </Field>
      </div>
      <div>
        <Button type="submit" variant="primary" loading={pending}>
          {t('setSubmit')}
        </Button>
      </div>
    </Form>
  )
}
