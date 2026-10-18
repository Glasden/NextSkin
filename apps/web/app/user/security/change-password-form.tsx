'use client'

import { Alert, Button, Field, Form, Input, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { authErrorCode, postJson } from '../../../lib/api-client'

/**
 * 改密码用 Better Auth 的接口，总是退出其他设备、当前设备保持登录（ADR-0023）。
 * 新密码的长度范围与注册相同
 */
export function ChangePasswordForm({ min, max }: { min: number; max: number }) {
  const t = useTranslations('user.security.password')
  const signUp = useTranslations('auth.signUp')
  const toast = useToast()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  // 改成功后换一个 key 清空表单
  const [generation, setGeneration] = useState(0)

  async function submit(values: { currentPassword?: string; newPassword?: string }) {
    setPending(true)
    setError(null)
    setErrors({})
    const { status, data } = await postJson('/api/auth/change-password', {
      currentPassword: values.currentPassword,
      newPassword: values.newPassword,
      revokeOtherSessions: true,
    })
    setPending(false)
    if (status === 200) {
      toast.show({ tone: 'success', title: t('changed') })
      setGeneration((value) => value + 1)
      return
    }
    const code = authErrorCode(data)
    if (code === 'INVALID_PASSWORD') setErrors({ currentPassword: t('wrong') })
    else if (code === 'PASSWORD_TOO_SHORT' || code === 'PASSWORD_TOO_LONG')
      setErrors({ newPassword: signUp('passwordHint', { min, max }) })
    else setError(status === 429 ? t('tooManyAttempts') : t('failed'))
  }

  return (
    <Form key={generation} errors={errors} onFormSubmit={(values) => void submit(values)}>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('current')} name="currentPassword">
          <Input type="password" autoComplete="current-password" required maxLength={max} />
        </Field>
        <Field label={t('new')} name="newPassword" description={signUp('passwordHint', { min, max })}>
          <Input type="password" autoComplete="new-password" required minLength={min} maxLength={max} />
        </Field>
      </div>
      <div>
        <Button type="submit" loading={pending}>
          {t('submit')}
        </Button>
      </div>
    </Form>
  )
}
