'use client'

import { Alert, Button, Field, Form, Input, Panel } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { Database } from 'pixelarticons/react/Database.js'
import { Home } from 'pixelarticons/react/Home.js'
import { useState, type ComponentType, type SVGProps } from 'react'
import { apiError, formErrors, postJson } from '../../lib/api-client'
import { ImportWizard } from '../_import/import-wizard'

type Path = 'choose' | 'new' | 'import'

/** 通过安装码之后：选“新站”还是“从 BS 导入”，然后进入对应的流程 */
export function SetupStart({
  siteName,
  siteUrl,
  password,
}: {
  siteName: string
  siteUrl: string
  password: { min: number; max: number }
}) {
  const t = useTranslations('setup')
  const [path, setPath] = useState<Path>('choose')

  return (
    <section className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="font-pixel text-pixel-2 text-text">{t(`headings.${path}`)}</h1>
        <p className="text-sm text-pretty text-text-muted">{t(`intro.${path}`)}</p>
      </header>
      {path === 'choose' && (
        <div className="grid gap-4 md:grid-cols-2">
          <PathCard
            icon={Home}
            title={t('paths.new.title')}
            description={t('paths.new.description')}
            points={[t('paths.new.point1'), t('paths.new.point2')]}
            action={t('paths.new.action')}
            onSelect={() => setPath('new')}
          />
          <PathCard
            icon={Database}
            title={t('paths.import.title')}
            description={t('paths.import.description')}
            points={[t('paths.import.point1'), t('paths.import.point2')]}
            action={t('paths.import.action')}
            onSelect={() => setPath('import')}
          />
        </div>
      )}
      {path === 'new' && (
        <NewSiteForm siteName={siteName} siteUrl={siteUrl} password={password} onBack={() => setPath('choose')} />
      )}
      {path === 'import' && (
        <ImportWizard
          base="/api/setup/import"
          defaults={null}
          siteUrl={siteUrl}
          leave={{ label: t('changePath'), onLeave: () => setPath('choose') }}
        />
      )}
    </section>
  )
}

function PathCard({
  icon: Icon,
  title,
  description,
  points,
  action,
  onSelect,
}: {
  icon: ComponentType<SVGProps<SVGSVGElement>>
  title: string
  description: string
  points: string[]
  action: string
  onSelect: () => void
}) {
  return (
    <Panel gap={4}>
      <span className="flex size-12 items-center justify-center rounded-sm bg-stage text-text">
        <Icon aria-hidden />
      </span>
      <div className="flex flex-col gap-2">
        <h2 className="font-pixel text-pixel-2 text-text">{title}</h2>
        <p className="text-sm text-pretty text-text-muted">{description}</p>
      </div>
      <ul className="flex flex-1 list-disc flex-col gap-1 pl-5 text-sm text-text">
        {points.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
      <div>
        <Button onClick={onSelect}>{action}</Button>
      </div>
    </Panel>
  )
}

/** 新站：站点名称、站点地址和第一个超级管理员。经过领域用例创建，完成后直接登录（ADR-0031） */
function NewSiteForm({
  siteName,
  siteUrl,
  password,
  onBack,
}: {
  siteName: string
  siteUrl: string
  password: { min: number; max: number }
  onBack: () => void
}) {
  const t = useTranslations('setup.newSite')
  const common = useTranslations('common')
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  async function submit(values: Record<string, string | undefined>) {
    setPending(true)
    setError(null)
    setErrors({})
    const { status, data } = await postJson('/api/setup/site', values)
    if (status === 201) {
      const signedIn = (data as { signedIn?: unknown } | null)?.signedIn === true
      router.replace(signedIn ? '/admin' : '/sign-in')
      router.refresh()
      return
    }
    setPending(false)
    const failure = apiError(data)
    if (failure?.fields) setErrors(formErrors(failure))
    else setError(failure?.message ?? t('failed'))
  }

  return (
    <div className="max-w-2xl">
      <Panel>
        <Form errors={errors} onFormSubmit={(values) => void submit(values)}>
          {error && <Alert tone="danger">{error}</Alert>}
          <fieldset className="flex flex-col gap-4">
            <legend className="mb-4 font-pixel text-pixel-1 text-text-muted">{t('site')}</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('siteName')} name="siteName">
                <Input defaultValue={siteName} required maxLength={64} />
              </Field>
              <Field
                label={t('siteUrl')}
                name="siteUrl"
                description={t('siteUrlHint')}
                formatError={common('urlFormat')}
              >
                <Input type="url" defaultValue={siteUrl} required />
              </Field>
            </div>
          </fieldset>
          <fieldset className="flex flex-col gap-4">
            <legend className="mb-4 font-pixel text-pixel-1 text-text-muted">{t('admin')}</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('email')} name="email" formatError={common('emailFormat')}>
                <Input type="email" autoComplete="email" required />
              </Field>
              <Field label={t('nickname')} name="nickname">
                <Input autoComplete="nickname" required maxLength={255} />
              </Field>
            </div>
            <Field label={t('password')} name="password" description={t('passwordHint', password)}>
              <Input
                type="password"
                autoComplete="new-password"
                required
                minLength={password.min}
                maxLength={password.max}
              />
            </Field>
          </fieldset>
          <div className="flex flex-wrap gap-3">
            <Button type="button" onClick={onBack}>
              {t('back')}
            </Button>
            <Button type="submit" variant="primary" loading={pending}>
              {t('submit')}
            </Button>
          </div>
        </Form>
      </Panel>
    </div>
  )
}
