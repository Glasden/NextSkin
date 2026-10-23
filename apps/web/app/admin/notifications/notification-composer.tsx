'use client'

import type { SendNotificationInput } from '@nextskin/domain'
import {
  Alert,
  Button,
  Dialog,
  DialogClose,
  Field,
  Form,
  Input,
  Markdown,
  NotificationItem,
  Panel,
  Select,
  Textarea,
  useToast,
} from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { apiError, formErrors, postJson } from '../../../lib/api-client'

type Audience = SendNotificationInput['audience']

const AUDIENCES = ['all', 'users', 'admins', 'specific'] as const satisfies readonly Audience[]

/** 一行一个 uid 或邮箱：去掉空行和首尾空白，重复的只留一个 */
function recipientLines(text: string): string[] {
  return [...new Set(text.split('\n').map((line) => line.trim()))].filter(Boolean)
}

/**
 * 发通知的表单（ADR-0052）。右边是收件人在通知列表里看到的样子，边写边变。
 * 群发先确认一次：发出去就到了每个人的列表里，发错了只能撤回。指定用户直接发
 */
export function NotificationComposer({ to }: { to: number | null }) {
  const t = useTranslations('admin.notifications')
  const admin = useTranslations('admin')
  const common = useTranslations('common')
  const site = useTranslations('site.notifications')
  const router = useRouter()
  const toast = useToast()
  const [audience, setAudience] = useState<Audience>(to === null ? 'all' : 'specific')
  const [recipients, setRecipients] = useState(to === null ? '' : String(to))
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  function submit() {
    setError(null)
    setErrors({})
    if (audience === 'specific') {
      const count = recipientLines(recipients).length
      if (count > 50) setErrors({ recipients: t('recipientsTooMany', { count }) })
      else void send()
    } else setConfirming(true)
  }

  async function send() {
    setPending(true)
    const { status, data } = await postJson('/api/admin/notifications', {
      audience,
      ...(audience === 'specific' ? { recipients: recipientLines(recipients) } : {}),
      title,
      body,
    })
    setPending(false)
    setConfirming(false)
    if (status === 201) {
      toast.show({ tone: 'success', title: t('sent', { audience }) })
      setTitle('')
      setBody('')
      setRecipients('')
      router.refresh()
      return
    }
    const failure = apiError(data)
    if (failure?.fields) setErrors(formErrors(failure))
    else setError(failure?.message ?? admin('failed'))
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Form errors={errors} onFormSubmit={submit}>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label={t('audience')} name="audience" nativeLabel={false} description={t(`audienceHints.${audience}`)}>
          <Select
            options={AUDIENCES.map((value) => ({ value, label: t(`audiences.${value}`) }))}
            value={audience}
            onValueChange={setAudience}
          />
        </Field>
        {audience === 'specific' && (
          <Field label={t('recipients')} name="recipients" description={t('recipientsHint')}>
            <Textarea rows={3} value={recipients} onValueChange={setRecipients} required />
          </Field>
        )}
        <Field label={t('titleLabel')} name="title" description={t('titleHint')}>
          <Input value={title} onValueChange={setTitle} maxLength={60} required autoComplete="off" />
        </Field>
        <Field label={t('body')} name="body" description={t('bodyHint')}>
          <Textarea rows={8} maxLength={5000} value={body} onValueChange={setBody} />
        </Field>
        <div>
          <Button type="submit" variant="primary" loading={pending && !confirming}>
            {t('send')}
          </Button>
        </div>
      </Form>

      <div className="flex min-w-0 flex-col gap-2">
        <h3 className="text-sm font-medium text-text">{t('preview')}</h3>
        <Panel padding="none">
          <NotificationItem
            title={title.trim() || t('previewUntitled')}
            time={t('previewTime')}
            unread
            unreadLabel={site('unread')}
          >
            {body.trim() ? <Markdown>{body}</Markdown> : undefined}
          </NotificationItem>
        </Panel>
      </div>

      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('confirmTitle', { audience })}
        description={t('confirmHint')}
        actions={
          <>
            <DialogClose>{common('cancel')}</DialogClose>
            <Button variant="primary" loading={pending} onClick={() => void send()}>
              {t('send')}
            </Button>
          </>
        }
      />
    </div>
  )
}
