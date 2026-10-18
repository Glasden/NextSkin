'use client'

import type { Locale } from '@nextskin/i18n'
import { Alert, Button, Field, Form, Input, Select, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { apiError, formErrors, sendJson } from '../../../lib/api-client'
import { localeOptions } from '../../../lib/locales'

/** 昵称和界面语言一起保存（PATCH /api/user）。改了语言，刷新后页面换成新的语言（ADR-0019） */
export function ProfileForm({ nickname, locale }: { nickname: string; locale: Locale }) {
  const t = useTranslations('user.profile.basics')
  const router = useRouter()
  const toast = useToast()
  const [language, setLanguage] = useState<Locale>(locale)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  async function submit(values: { nickname?: string }) {
    setPending(true)
    setError(null)
    setErrors({})
    const { status, data } = await sendJson('PATCH', '/api/user', { nickname: values.nickname, locale: language })
    setPending(false)
    if (status === 200) {
      toast.show({ tone: 'success', title: t('saved') })
      router.refresh()
      return
    }
    const failure = apiError(data)
    if (failure?.fields) setErrors(formErrors(failure))
    else setError(failure?.message ?? t('failed'))
  }

  return (
    <Form errors={errors} onFormSubmit={(values) => void submit(values)}>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('nickname')} name="nickname" description={t('nicknameHint')}>
          <Input defaultValue={nickname} maxLength={255} required autoComplete="nickname" />
        </Field>
        <Field label={t('locale')} name="locale" nativeLabel={false} description={t('localeHint')}>
          <Select options={localeOptions} value={language} onValueChange={setLanguage} />
        </Field>
      </div>
      <div>
        <Button type="submit" loading={pending}>
          {t('save')}
        </Button>
      </div>
    </Form>
  )
}
