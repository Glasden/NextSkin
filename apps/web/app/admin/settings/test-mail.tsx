'use client'

import { Button, Panel, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { apiError, sendJson } from '../../../lib/api-client'

/** 用已经保存的邮件设置，当场给自己发一封测试邮件；SMTP 的报错原样显示出来（ADR-0028） */
export function TestMail({ email }: { email: string }) {
  const t = useTranslations('admin.settings.testMail')
  const admin = useTranslations('admin')
  const toast = useToast()
  const [pending, setPending] = useState(false)

  async function send() {
    setPending(true)
    const { status, data } = await sendJson('POST', '/api/admin/settings/mail/test')
    setPending(false)
    if (status === 200) toast.show({ tone: 'success', title: t('sent', { to: email }) })
    else toast.show({ tone: 'danger', title: apiError(data)?.message ?? admin('failed'), timeout: 0 })
  }

  return (
    <Panel as="section" padding="responsive">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-pretty text-text-muted">{t('hint', { email })}</p>
        <div className="shrink-0">
          <Button variant="secondary" loading={pending} onClick={() => void send()}>
            {t('button')}
          </Button>
        </div>
      </div>
    </Panel>
  )
}
