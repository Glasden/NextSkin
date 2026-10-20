'use client'

import type { OAuthClientType } from '@nextskin/domain'
import { Alert, Button, Dialog, DialogClose, Field, Form, Input, Select, Textarea, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { Key } from 'pixelarticons/react/Key.js'
import { Pencil } from 'pixelarticons/react/Pencil.js'
import { Trash } from 'pixelarticons/react/Trash.js'
import { useState } from 'react'
import { apiError, sendJson } from '../../../lib/api-client'
import { CopyValueButton } from './copy-value-button'

// 用户中心的 OAuth 应用（ADR-0037"用户中心的'OAuth 应用'"）：创建、修改、重置密钥、删除。
// 规则都在领域用例里，这里只把回调地址按行拆开，错误照接口给的文案显示

/** 文本框里每行一条；去空白、去重由用例做 */
function redirectLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

interface Credentials {
  clientId: string
  /** 启动器类型没有密钥 */
  clientSecret: string | null
}

/** 刚创建或重置之后的凭据：密钥只显示这一次（ADR-0037），关掉对话框就再也看不到 */
function CredentialsView({ clientId, clientSecret }: Credentials) {
  const t = useTranslations('user.oauthClients')
  return (
    <div className="flex flex-col gap-4">
      <Alert tone={clientSecret ? 'warning' : 'info'}>{clientSecret ? t('secretOnce') : t('noSecret')}</Alert>
      <dl className="flex flex-col gap-3">
        <CredentialRow label={t('clientId')} value={clientId} copy={t('copyClientId')} done={t('clientIdCopied')} />
        {clientSecret && (
          <CredentialRow
            label={t('clientSecret')}
            value={clientSecret}
            copy={t('copySecret')}
            done={t('secretCopied')}
          />
        )}
      </dl>
    </div>
  )
}

function CredentialRow({ label, value, copy, done }: { label: string; value: string; copy: string; done: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-sm text-text-muted">{label}</dt>
      <dd className="flex items-start gap-1 rounded-sm border border-border bg-surface-sunken py-1 pr-1 pl-3">
        <code className="min-w-0 flex-1 py-1.5 font-mono text-sm break-all text-text select-all">{value}</code>
        <CopyValueButton value={value} label={copy} done={done} />
      </dd>
    </div>
  )
}

const TYPES: readonly OAuthClientType[] = ['web', 'native']

export function CreateClientDialog({ disabled }: { disabled: boolean }) {
  const t = useTranslations('user.oauthClients')
  const common = useTranslations('common')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<OAuthClientType>('web')
  const [redirects, setRedirects] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<(Credentials & { name: string }) | null>(null)

  async function submit(values: { name?: unknown }) {
    setPending(true)
    setError(null)
    const { status, data } = await sendJson('POST', '/api/oauth-clients', {
      name: values.name,
      type,
      redirectUris: redirectLines(redirects),
    })
    setPending(false)
    if (status === 201) {
      const { client, clientSecret } = data as {
        client: { clientId: string; name: string }
        clientSecret: string | null
      }
      setCreated({ clientId: client.clientId, clientSecret, name: client.name })
      return
    }
    setError(apiError(data)?.message ?? t('failed'))
  }

  function changeOpen(next: boolean) {
    setOpen(next)
    if (next) {
      setType('web')
      setRedirects('')
      setError(null)
      setCreated(null)
    }
    // 关掉之后才刷新列表：建好第一个应用时，这个按钮会从空状态移到页头，提前刷新会换掉对话框，密钥跟着消失
    else if (created) router.refresh()
  }

  return (
    <Dialog
      // 点外面不关闭：密钥只显示这一次，不能因为误点丢掉。不在显示凭据时才切过去：换 Root 会整个重新挂载
      alert
      open={open}
      onOpenChange={changeOpen}
      trigger={
        <Button variant="primary" disabled={disabled}>
          {t('create')}
        </Button>
      }
      title={created ? t('createdTitle', { name: created.name }) : t('create')}
      description={created ? undefined : t('createDescription')}
      actions={
        created ? (
          <Button variant="primary" onClick={() => changeOpen(false)}>
            {t('done')}
          </Button>
        ) : (
          <>
            <DialogClose>{common('cancel')}</DialogClose>
            <Button type="submit" form="create-oauth-client" variant="primary" loading={pending}>
              {t('create')}
            </Button>
          </>
        )
      }
    >
      {created ? (
        <CredentialsView clientId={created.clientId} clientSecret={created.clientSecret} />
      ) : (
        <Form id="create-oauth-client" onFormSubmit={(values) => void submit(values)}>
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label={t('name')} name="name" description={t('nameHint')}>
            <Input maxLength={255} required autoComplete="off" />
          </Field>
          <Field label={t('type')} nativeLabel={false} description={t(`typeHints.${type}`)}>
            <Select<OAuthClientType>
              value={type}
              onValueChange={setType}
              options={TYPES.map((value) => ({ value, label: t(`types.${value}`) }))}
            />
          </Field>
          <Field label={t('redirectUris')} description={t(`redirectHints.${type}`)}>
            <Textarea value={redirects} onValueChange={setRedirects} rows={3} />
          </Field>
        </Form>
      )}
    </Dialog>
  )
}

export interface ClientActionsProps {
  client: {
    id: number
    /** 已经换成界面上显示的名字（没有名称时是"未命名的应用"） */
    name: string
    type: OAuthClientType
    redirectUris: string[]
    deviceCode: boolean
    authorizedUsers: number
  }
  /** 被封禁，或者需要先验证邮箱 */
  locked: boolean
}

/** 一个应用卡片底部的操作 */
export function ClientActions({ client, locked }: ClientActionsProps) {
  return (
    <>
      <EditClientDialog client={client} disabled={locked} />
      {client.type === 'web' && <ResetSecretDialog client={client} disabled={locked} />}
      <DeleteClientDialog client={client} disabled={locked} />
    </>
  )
}

type DialogProps = { client: ClientActionsProps['client']; disabled: boolean }

/** 改名称和回调地址；类型创建后不能改。已有的回调地址照旧保留，新加的按类型校验（ADR-0037） */
function EditClientDialog({ client, disabled }: DialogProps) {
  const t = useTranslations('user.oauthClients')
  const common = useTranslations('common')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toast = useToast()
  const [redirects, setRedirects] = useState(client.redirectUris.join('\n'))
  const formId = `edit-oauth-client-${client.id}`

  async function submit(values: { name?: unknown }) {
    setPending(true)
    setError(null)
    const { status, data } = await sendJson('PATCH', `/api/oauth-clients/${client.id}`, {
      name: values.name,
      redirectUris: redirectLines(redirects),
    })
    setPending(false)
    if (status === 200) {
      setOpen(false)
      toast.show({
        tone: 'success',
        title: t('saved', { name: (data as { name: string | null }).name ?? client.name }),
      })
      router.refresh()
      return
    }
    setError(apiError(data)?.message ?? t('failed'))
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setRedirects(client.redirectUris.join('\n'))
          setError(null)
        }
      }}
      trigger={
        <Button size="sm" disabled={disabled}>
          <Pencil aria-hidden />
          {t('edit')}
        </Button>
      }
      title={t('editTitle', { name: client.name })}
      description={t('editDescription')}
      actions={
        <>
          <DialogClose>{common('cancel')}</DialogClose>
          <Button type="submit" form={formId} variant="primary" loading={pending}>
            {t('save')}
          </Button>
        </>
      }
    >
      <Form id={formId} onFormSubmit={(values) => void submit(values)}>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label={t('name')} name="name">
          <Input defaultValue={client.name} maxLength={255} required autoComplete="off" />
        </Field>
        <Field
          label={t('redirectUris')}
          description={client.deviceCode ? t(`redirectHints.${client.type}`) : t('redirectRequired')}
        >
          <Textarea value={redirects} onValueChange={setRedirects} rows={Math.max(3, client.redirectUris.length)} />
        </Field>
      </Form>
    </Dialog>
  )
}

/** 重置密钥：旧密钥立即失效；已签发的令牌和同意记录不动（ADR-0037） */
function ResetSecretDialog({ client, disabled }: DialogProps) {
  const t = useTranslations('user.oauthClients')
  const common = useTranslations('common')
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [credentials, setCredentials] = useState<Credentials | null>(null)

  async function reset() {
    setPending(true)
    setError(null)
    const { status, data } = await sendJson('POST', `/api/oauth-clients/${client.id}/secret`)
    setPending(false)
    if (status === 200) {
      const { client: updated, clientSecret } = data as { client: { clientId: string }; clientSecret: string }
      setCredentials({ clientId: updated.clientId, clientSecret })
      return
    }
    setError(apiError(data)?.message ?? t('failed'))
  }

  return (
    <Dialog
      alert
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setError(null)
          setCredentials(null)
        }
      }}
      trigger={
        <Button size="sm" disabled={disabled}>
          <Key aria-hidden />
          {t('resetSecret')}
        </Button>
      }
      title={credentials ? t('secretResetTitle', { name: client.name }) : t('resetTitle', { name: client.name })}
      description={credentials ? undefined : t('resetDescription')}
      actions={
        credentials ? (
          <Button variant="primary" onClick={() => setOpen(false)}>
            {t('done')}
          </Button>
        ) : (
          <>
            <DialogClose>{common('cancel')}</DialogClose>
            <Button variant="danger" loading={pending} onClick={() => void reset()}>
              {t('resetConfirm')}
            </Button>
          </>
        )
      }
    >
      {credentials ? <CredentialsView {...credentials} /> : error && <Alert tone="danger">{error}</Alert>}
    </Dialog>
  )
}

/** 删除：令牌和同意记录随外键删掉，已授权的用户全部失效（ADR-0037） */
function DeleteClientDialog({ client, disabled }: DialogProps) {
  const t = useTranslations('user.oauthClients')
  const common = useTranslations('common')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toast = useToast()

  async function remove() {
    setPending(true)
    setError(null)
    const { status, data } = await sendJson('DELETE', `/api/oauth-clients/${client.id}`)
    setPending(false)
    if (status === 204) {
      setOpen(false)
      toast.show({ tone: 'success', title: t('deleted', { name: client.name }) })
      router.refresh()
      return
    }
    setError(apiError(data)?.message ?? t('failed'))
  }

  return (
    <Dialog
      alert
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setError(null)
      }}
      trigger={
        <Button size="sm" disabled={disabled}>
          <Trash aria-hidden />
          {t('delete')}
        </Button>
      }
      title={t('deleteTitle', { name: client.name })}
      description={t('deleteDescription', { count: client.authorizedUsers })}
      actions={
        <>
          <DialogClose>{common('cancel')}</DialogClose>
          <Button variant="danger" loading={pending} onClick={() => void remove()}>
            {t('deleteConfirm')}
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
    </Dialog>
  )
}
