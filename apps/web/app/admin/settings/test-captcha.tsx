'use client'

import { Alert, Button, Dialog, DialogClose, Panel } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { apiError, sendJson } from '../../../lib/api-client'
import { CAPTCHA_HEADER, useCaptcha, type CaptchaConfig } from '../../../lib/captcha'

type Outcome =
  | { result: 'passed' | 'failed' | 'unavailable'; errorCodes: string[] }
  | { result: 'error'; message: string }
  | { result: 'incomplete' }

/**
 * 用已经保存的验证码设置，在对话框里当场过一次挂件、按正式流程核对（ADR-0038"后台"）。
 * 站点密钥填错、密钥对不上、服务端连不上服务商，保存之后马上能看出来
 */
export function TestCaptcha({ config }: { config: CaptchaConfig | null }) {
  const t = useTranslations('admin.settings.testCaptcha')
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)

  return (
    <Panel as="section" padding="responsive">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-pretty text-text-muted">{config ? t('hint') : t('notConfigured')}</p>
        <div className="shrink-0">
          <Dialog
            open={open}
            onOpenChange={setOpen}
            trigger={<Button disabled={!config}>{t('button')}</Button>}
            title={t('title')}
            description={t('description')}
            actions={
              <>
                <DialogClose>{t('close')}</DialogClose>
                <Button variant="primary" type="submit" form="captcha-test" loading={pending}>
                  {t('verify')}
                </Button>
              </>
            }
          >
            {config && <CaptchaTestForm config={config} pending={pending} onPendingChange={setPending} />}
          </Dialog>
        </div>
      </div>
    </Panel>
  )
}

/** 对话框打开时才挂上：关掉再打开就是一个新挂件、一次新的核对 */
function CaptchaTestForm({
  config,
  pending,
  onPendingChange: setPending,
}: {
  config: CaptchaConfig
  pending: boolean
  onPendingChange: (pending: boolean) => void
}) {
  const admin = useTranslations('admin')
  const captcha = useCaptcha(config)
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  async function verify() {
    if (pending) return
    setOutcome(null)
    const token = await captcha.getToken()
    if (!token) {
      setOutcome({ result: 'incomplete' })
      return
    }
    setPending(true)
    const { status, data } = await sendJson('POST', '/api/admin/settings/captcha/test', undefined, {
      headers: { [CAPTCHA_HEADER]: token },
    })
    setPending(false)
    captcha.reset()
    if (status === 200) setOutcome(data as Outcome)
    else setOutcome({ result: 'error', message: apiError(data)?.message ?? admin('failed') })
  }

  return (
    <form
      id="captcha-test"
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        void verify()
      }}
    >
      {captcha.element}
      {outcome && <OutcomeAlert outcome={outcome} />}
    </form>
  )
}

function OutcomeAlert({ outcome }: { outcome: Outcome }) {
  const t = useTranslations('admin.settings.testCaptcha')
  switch (outcome.result) {
    case 'passed':
      return (
        <Alert tone="success" title={t('passed')}>
          {t('passedHint')}
        </Alert>
      )
    case 'failed':
    case 'unavailable':
      return (
        <Alert tone={outcome.result === 'failed' ? 'warning' : 'danger'} title={t(outcome.result)}>
          {t(`${outcome.result}Hint`)}
          {outcome.errorCodes.length > 0 && (
            <span className="mt-2 block font-mono">{t('errorCodes', { codes: outcome.errorCodes.join(', ') })}</span>
          )}
        </Alert>
      )
    case 'incomplete':
      return <Alert tone="warning">{t('incomplete')}</Alert>
    case 'error':
      return <Alert tone="danger">{outcome.message}</Alert>
  }
}
