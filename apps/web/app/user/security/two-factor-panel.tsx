'use client'

import { Alert, Button, Dialog, DialogClose, Field, Form, Input, QrCode, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { authErrorCode, postJson } from '../../../lib/api-client'
import { BackupCodes } from './backup-codes'
import { CopyButton } from './copy-button'

export interface TwoFactorPanelProps {
  enabled: boolean
  /** 开着两步验证时还剩几个备用码 */
  backupCodesRemaining: number | null
  /** 下载的备用码文件里写上站点名，免得以后认不出是哪个网站的 */
  siteName: string
}

/** 两步验证只做验证器应用（TOTP）加备用码（ADR-0023），开关都要输入当前密码 */
export function TwoFactorPanel({ enabled, backupCodesRemaining, siteName }: TwoFactorPanelProps) {
  const t = useTranslations('user.security.twoFactor')
  return (
    <div className="flex flex-col gap-4">
      {enabled && backupCodesRemaining !== null && (
        <p className={backupCodesRemaining <= 3 ? 'text-sm text-warning' : 'text-sm text-text'}>
          {t('remaining', { count: backupCodesRemaining })}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        {enabled ? (
          <>
            <RegenerateDialog siteName={siteName} />
            <DisableDialog />
          </>
        ) : (
          <EnableDialog siteName={siteName} />
        )}
      </div>
      <p className="text-sm text-pretty text-text-muted">{t('launcherNote')}</p>
      {enabled && <p className="text-sm text-pretty text-text-muted">{t('lostAccess')}</p>}
    </div>
  )
}

/** 核对密码的错误：密码不对挂在密码框下面，其他的放在表单顶部 */
function usePasswordErrors() {
  const t = useTranslations('user.security')
  return (status: number, data: unknown): { field?: Record<string, string>; message?: string } => {
    if (authErrorCode(data) === 'INVALID_PASSWORD') return { field: { password: t('password.wrong') } }
    return { message: status === 429 ? t('password.tooManyAttempts') : t('twoFactor.failed') }
  }
}

type EnableStep =
  | { name: 'password' }
  | { name: 'scan'; uri: string; secret: string; backupCodes: string[] }
  | { name: 'codes'; backupCodes: string[] }

/** TOTP 地址里的密钥，四个字符一组，方便手动输入 */
function secretOf(uri: string): string {
  const secret = new URL(uri).searchParams.get('secret') ?? ''
  return secret.replace(/(.{4})(?=.)/g, '$1 ')
}

/**
 * 开启分三步：输入密码拿到二维码和备用码，此时还没有生效；用验证器上的数字验证通过才开启；最后显示备用码，
 * 只显示这一次。中途关掉对话框不会开启
 */
function EnableDialog({ siteName }: { siteName: string }) {
  const t = useTranslations('user.security.twoFactor')
  const common = useTranslations('common')
  const router = useRouter()
  const toast = useToast()
  const passwordErrors = usePasswordErrors()
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<EnableStep>({ name: 'password' })
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const formId = 'enable-two-factor'

  function reset() {
    setStep({ name: 'password' })
    setError(null)
    setErrors({})
  }

  async function confirmPassword(values: { password?: string }) {
    setPending(true)
    setError(null)
    setErrors({})
    const { status, data } = await postJson('/api/auth/two-factor/enable', { password: values.password })
    setPending(false)
    if (status === 200) {
      const { totpURI, backupCodes } = data as { totpURI: string; backupCodes: string[] }
      setStep({ name: 'scan', uri: totpURI, secret: secretOf(totpURI), backupCodes })
      return
    }
    const failure = passwordErrors(status, data)
    if (failure.field) setErrors(failure.field)
    else setError(failure.message ?? null)
  }

  async function verify(values: { code?: string }, backupCodes: string[]) {
    setPending(true)
    setError(null)
    setErrors({})
    const { status, data } = await postJson('/api/auth/two-factor/verify-totp', { code: values.code?.trim() })
    setPending(false)
    if (status === 200) {
      setStep({ name: 'codes', backupCodes })
      return
    }
    if (authErrorCode(data) === 'INVALID_CODE') setErrors({ code: t('invalidCode') })
    else setError(status === 429 ? t('tooManyAttempts') : t('failed'))
  }

  function finish() {
    setOpen(false)
    toast.show({ tone: 'success', title: t('enabled') })
    router.refresh()
  }

  const stepNumber = { password: 1, scan: 2, codes: 3 }[step.name]
  const description = {
    password: t('passwordStep'),
    scan: t('scanStep'),
    codes: t('codesStep'),
  }[step.name]

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // 第三步时两步验证已经开启，怎么关掉对话框都要刷新页面
        if (!next && step.name === 'codes') router.refresh()
        setOpen(next)
        if (next) reset()
      }}
      trigger={<Button variant="primary">{t('enable')}</Button>}
      title={t('enable')}
      description={`${t('step', { step: stepNumber })} ${description}`}
      actions={
        step.name === 'codes' ? (
          <Button variant="primary" onClick={finish}>
            {t('done')}
          </Button>
        ) : (
          <>
            <DialogClose>{common('cancel')}</DialogClose>
            <Button type="submit" form={formId} variant="primary" loading={pending}>
              {step.name === 'password' ? t('continue') : t('verify')}
            </Button>
          </>
        )
      }
    >
      {step.name === 'password' && (
        <Form id={formId} errors={errors} onFormSubmit={(values) => void confirmPassword(values)}>
          {error && <Alert tone="danger">{error}</Alert>}
          <PasswordField />
        </Form>
      )}
      {step.name === 'scan' && (
        <Form id={formId} errors={errors} onFormSubmit={(values) => void verify(values, step.backupCodes)}>
          {error && <Alert tone="danger">{error}</Alert>}
          {/* 二维码有两百多像素宽，对话框里放不下并排的密钥，上下排 */}
          <div className="flex justify-center">
            <QrCode value={step.uri} label={t('qrLabel')} />
          </div>
          <div className="flex flex-col items-start gap-2">
            <p className="text-sm text-pretty text-text-muted">{t('manualKey')}</p>
            <code className="w-full rounded-sm bg-surface-sunken px-3 py-2 font-mono text-sm break-words text-text">
              {step.secret}
            </code>
            <CopyButton text={step.secret.replaceAll(' ', '')} label={t('copyKey')} done={t('keyCopied')} />
          </div>
          <Field label={t('code')} name="code" description={t('codeHint')}>
            <Input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              autoFocus
            />
          </Field>
        </Form>
      )}
      {step.name === 'codes' && <BackupCodes codes={step.backupCodes} siteName={siteName} />}
    </Dialog>
  )
}

/** 重新生成备用码：旧的全部作废，新的只显示这一次 */
function RegenerateDialog({ siteName }: { siteName: string }) {
  const t = useTranslations('user.security.twoFactor')
  const common = useTranslations('common')
  const router = useRouter()
  const passwordErrors = usePasswordErrors()
  const [open, setOpen] = useState(false)
  const [codes, setCodes] = useState<string[] | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const formId = 'regenerate-backup-codes'

  async function submit(values: { password?: string }) {
    setPending(true)
    setError(null)
    setErrors({})
    const { status, data } = await postJson('/api/auth/two-factor/generate-backup-codes', {
      password: values.password,
    })
    setPending(false)
    if (status === 200) {
      setCodes((data as { backupCodes: string[] }).backupCodes)
      return
    }
    const failure = passwordErrors(status, data)
    if (failure.field) setErrors(failure.field)
    else setError(failure.message ?? null)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && codes) router.refresh()
        setOpen(next)
        if (next) {
          setCodes(null)
          setError(null)
          setErrors({})
        }
      }}
      trigger={<Button>{t('regenerate')}</Button>}
      title={t('regenerate')}
      description={codes ? t('regenerated') : t('regenerateDescription')}
      actions={
        codes ? (
          <DialogClose>{t('done')}</DialogClose>
        ) : (
          <>
            <DialogClose>{common('cancel')}</DialogClose>
            <Button type="submit" form={formId} variant="primary" loading={pending}>
              {t('regenerateSubmit')}
            </Button>
          </>
        )
      }
    >
      {codes ? (
        <BackupCodes codes={codes} siteName={siteName} />
      ) : (
        <Form id={formId} errors={errors} onFormSubmit={(values) => void submit(values)}>
          {error && <Alert tone="danger">{error}</Alert>}
          <PasswordField />
        </Form>
      )}
    </Dialog>
  )
}

function DisableDialog() {
  const t = useTranslations('user.security.twoFactor')
  const common = useTranslations('common')
  const router = useRouter()
  const toast = useToast()
  const passwordErrors = usePasswordErrors()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const formId = 'disable-two-factor'

  async function submit(values: { password?: string }) {
    setPending(true)
    setError(null)
    setErrors({})
    const { status, data } = await postJson('/api/auth/two-factor/disable', { password: values.password })
    setPending(false)
    if (status === 200) {
      setOpen(false)
      toast.show({ tone: 'success', title: t('disabled') })
      router.refresh()
      return
    }
    const failure = passwordErrors(status, data)
    if (failure.field) setErrors(failure.field)
    else setError(failure.message ?? null)
  }

  return (
    <Dialog
      alert
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setError(null)
          setErrors({})
        }
      }}
      trigger={<Button>{t('disable')}</Button>}
      title={t('disableTitle')}
      description={t('disableDescription')}
      actions={
        <>
          <DialogClose>{common('cancel')}</DialogClose>
          <Button type="submit" form={formId} variant="danger" loading={pending}>
            {t('disable')}
          </Button>
        </>
      }
    >
      <Form id={formId} errors={errors} onFormSubmit={(values) => void submit(values)}>
        {error && <Alert tone="danger">{error}</Alert>}
        <PasswordField />
      </Form>
    </Dialog>
  )
}

function PasswordField() {
  const t = useTranslations('user.security.password')
  return (
    <Field label={t('current')} name="password">
      <Input type="password" autoComplete="current-password" required />
    </Field>
  )
}
