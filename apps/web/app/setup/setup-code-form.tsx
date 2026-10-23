'use client'

import { Alert, Button, Field, Form, Input, Panel, SkinFigure, Stage } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { apiError, formErrors, postJson } from '../../lib/api-client'
import { defaultSkin } from '../../lib/default-skin'

/**
 * 进入向导先输入安装码：公网上刚装好的站点谁都能打开 /setup，安装码证明你能读到服务器上的文件（ADR-0031）。
 * 通过后接口设一个只用于安装的 Cookie，刷新页面就进入向导
 */
export function SetupCodeForm() {
  const t = useTranslations('setup.code')
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  async function submit(values: { code?: string }) {
    setPending(true)
    setError(null)
    setErrors({})
    const { status, data } = await postJson('/api/setup/code', { code: values.code ?? '' })
    if (status === 204) {
      router.refresh()
      return
    }
    setPending(false)
    const failure = apiError(data)
    if (failure?.fields) setErrors(formErrors(failure))
    else setError(failure?.message ?? t('failed'))
  }

  return (
    <div className="flex items-start gap-8">
      <Panel grow gap={6}>
        <div className="flex flex-col gap-2 text-sm text-text">
          <p>{t('where')}</p>
          <pre className="overflow-x-auto rounded-sm bg-surface-sunken px-3 py-2 font-mono text-sm text-text">
            {t('command')}
          </pre>
          <p className="text-text-muted">{t('why')}</p>
        </div>
        <Form errors={errors} onFormSubmit={(values) => void submit(values)}>
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label={t('label')} name="code">
            <Input required autoComplete="off" spellCheck={false} maxLength={32} placeholder="XXXX-XXXX-XXXX-XXXX" />
          </Field>
          <div>
            <Button type="submit" variant="primary" loading={pending}>
              {t('submit')}
            </Button>
          </div>
        </Form>
      </Panel>
      <div className="hidden h-80 w-64 shrink-0 md:block">
        <Stage grid>
          <SkinFigure {...defaultSkin} scale={4} alt={t('illustration')} raiseOnHover loading="eager" />
        </Stage>
      </div>
    </div>
  )
}
