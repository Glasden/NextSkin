'use client'

import type { AdminUserLookup, SendNotificationInput } from '@nextskin/domain'
import {
  Alert,
  Badge,
  Button,
  Dialog,
  DialogClose,
  Field,
  Form,
  Input,
  Markdown,
  MultiCombobox,
  NotificationItem,
  Panel,
  PlayerHead,
  Select,
  Textarea,
  useToast,
} from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { apiError, formErrors, getJson, postJson } from '../../../lib/api-client'
import { headSrc } from '../../../lib/textures'
import { roleTones } from '../users/role-changes'

type Audience = SendNotificationInput['audience']

const AUDIENCES = ['all', 'users', 'admins', 'specific'] as const satisfies readonly Audience[]
/** 和领域用例的上限相同 */
const MAX_RECIPIENTS = 50

/** 搜收件人：停止输入 200ms 后再查，只显示输入框里现在这串文字的结果 */
function useRecipientSearch() {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<{ query: string; items: AdminUserLookup[]; failed: boolean }>({
    query: '',
    items: [],
    failed: false,
  })
  useEffect(() => {
    const q = query.trim()
    if (!q) return
    let stale = false
    async function search() {
      const { status, data } = await getJson(`/api/admin/notifications/recipients?q=${encodeURIComponent(q)}`)
      if (stale) return
      if (status === 200) setResult({ query, items: (data as { items: AdminUserLookup[] }).items, failed: false })
      else setResult({ query, items: [], failed: true })
    }
    const timer = setTimeout(() => void search(), 200)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [query])
  // 新结果到之前不留上一次的：两次搜的可能毫不相干，回车会选中旧列表里的人
  const current = query.trim() !== '' && result.query === query
  return {
    query,
    setQuery,
    items: current ? result.items : [],
    loading: query.trim() !== '' && !current,
    failed: current && result.failed,
  }
}

/**
 * 发通知的表单（ADR-0052）。右边是收件人在通知列表里看到的样子，边写边变。
 * 群发先确认一次：发出去就到了每个人的列表里，发错了只能撤回。指定用户直接发，收件人按 uid、昵称或邮箱搜出来选
 */
export function NotificationComposer({ to }: { to: AdminUserLookup | null }) {
  const t = useTranslations('admin.notifications')
  const admin = useTranslations('admin')
  const common = useTranslations('common')
  const site = useTranslations('site.notifications')
  const router = useRouter()
  const toast = useToast()
  const [audience, setAudience] = useState<Audience>(to === null ? 'all' : 'specific')
  const [recipients, setRecipients] = useState<readonly AdminUserLookup[]>(to === null ? [] : [to])
  const search = useRecipientSearch()
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
      if (recipients.length === 0) setErrors({ recipients: t('recipientsRequired') })
      else void send()
    } else setConfirming(true)
  }

  async function send() {
    setPending(true)
    const { status, data } = await postJson('/api/admin/notifications', {
      audience,
      ...(audience === 'specific' ? { recipients: recipients.map((user) => String(user.uid)) } : {}),
      title,
      body,
    })
    setPending(false)
    setConfirming(false)
    if (status === 201) {
      toast.show({ tone: 'success', title: t('sent', { audience }) })
      setTitle('')
      setBody('')
      setRecipients([])
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
            <MultiCombobox
              value={recipients}
              onValueChange={setRecipients}
              items={search.items}
              inputValue={search.query}
              onInputValueChange={search.setQuery}
              loading={search.loading}
              itemKey={(user) => String(user.uid)}
              itemLabel={(user) => user.nickname}
              renderItem={(user) => (
                <>
                  <PlayerHead src={user.avatar ? headSrc(user.avatar.hash) : undefined} size={24} alt="" />
                  <span className="min-w-0 truncate">{user.nickname}</span>
                  {user.role !== 'user' && <Badge tone={roleTones[user.role]}>{admin(`roles.${user.role}`)}</Badge>}
                  <span className="min-w-0 flex-1 truncate text-sm text-text-muted">{user.email}</span>
                  <span className="shrink-0 font-mono text-sm text-text-muted">{user.uid}</span>
                </>
              )}
              renderChip={(user) => (
                <>
                  <PlayerHead src={user.avatar ? headSrc(user.avatar.hash) : undefined} size={24} alt="" />
                  <span className="min-w-0 truncate">{user.nickname}</span>
                </>
              )}
              placeholder={t('recipientsPlaceholder')}
              hintLabel={t('recipientsPrompt')}
              loadingLabel={t('recipientsSearching')}
              emptyLabel={search.failed ? t('recipientsSearchFailed') : t('recipientsEmpty')}
              removeLabel={(name) => t('recipientsRemove', { name })}
              max={MAX_RECIPIENTS}
            />
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
