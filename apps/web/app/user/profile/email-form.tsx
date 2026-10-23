'use client'

import { Alert, Button, Field, Form, Input, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { apiError, formErrors, postJson } from '../../../lib/api-client'

/**
 * 改邮箱要输入当前密码。配置了邮件时先给新地址发确认邮件，点开链接才生效；没有配置邮件时立即生效（ADR-0023）
 */
export function EmailForm({ mailConfigured }: { mailConfigured: boolean }) {
  const t = useTranslations('user.profile.email')
  const common = useTranslations('common')
  const router = useRouter()
  const toast = useToast()
  const [pending, setPending] = useState(false)
  const [pendingEmail, setPendingEmail] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  // 提交成功后换一个 key 清空表单，密码不留在输入框里
  const [generation, setGeneration] = useState(0)

  async function submit(values: { email?: string; password?: string }) {
    setPending(true)
    setError(null)
    setErrors({})
    setPendingEmail(null)
    const { status, data } = await postJson('/api/user/email', { email: values.email, password: values.password })
    setPending(false)
    if (status === 202) {
      setPendingEmail((data as { pendingEmail: string }).pendingEmail)
      setGeneration((value) => value + 1)
      return
    }
    if (status === 200) {
      toast.show({ tone: 'success', title: t('changed', { email: (data as { email: string }).email }) })
      setGeneration((value) => value + 1)
      router.refresh()
      return
    }
    const failure = apiError(data)
    if (failure?.fields) setErrors(formErrors(failure))
    else setError(failure?.message ?? t('failed'))
  }

  return (
    <div className="flex flex-col gap-4">
      {pendingEmail && (
        <Alert tone="success" title={t('pendingTitle')}>
          {t('pending', { email: pendingEmail })}
        </Alert>
      )}
      <Form key={generation} errors={errors} onFormSubmit={(values) => void submit(values)}>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('new')} name="email" formatError={common('emailFormat')}>
            <Input type="email" autoComplete="email" maxLength={255} required />
          </Field>
          <Field label={t('password')} name="password">
            <Input type="password" autoComplete="current-password" required />
          </Field>
        </div>
        <div>
          <Button type="submit" loading={pending}>
            {mailConfigured ? t('submit') : t('submitNow')}
          </Button>
        </div>
      </Form>
    </div>
  )
}
