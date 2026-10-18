'use client'

import { Alert, Badge, Button, Dialog, DialogClose, Field, Form, Input, useToast } from '@nextskin/ui'
import { startRegistration, type PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { Key } from 'pixelarticons/react/Key.js'
import { useState } from 'react'
import { authErrorCode, getJson, postJson } from '../../../lib/api-client'
import { useWebAuthnSupported, webAuthnFailure } from '../../../lib/webauthn'

export interface PasskeyItem {
  id: string
  name: string | null
  backedUp: boolean
  /** 已经按页面的语言格式化好的添加时间 */
  addedAt: string | null
}

const NAME_MAX_LENGTH = 64

export function PasskeysPanel({ passkeys }: { passkeys: PasskeyItem[] }) {
  const t = useTranslations('user.security.passkeys')
  // 服务端渲染时先当作支持，免得按钮在大多数浏览器上闪一下禁用
  const supported = useWebAuthnSupported(true)

  return (
    <div className="flex flex-col gap-4">
      {passkeys.length ? (
        <ul className="divide-y divide-border rounded-sm border border-border">
          {passkeys.map((passkey) => (
            <PasskeyRow key={passkey.id} passkey={passkey} />
          ))}
        </ul>
      ) : (
        <p className="rounded-sm border border-dashed border-border-strong px-4 py-6 text-sm text-text-muted">
          {t('empty')}
        </p>
      )}
      <div className="flex flex-col items-start gap-2">
        <AddPasskeyDialog disabled={!supported} />
        {!supported && <p className="text-sm text-text-muted">{t('unsupported')}</p>}
      </div>
    </div>
  )
}

function PasskeyRow({ passkey }: { passkey: PasskeyItem }) {
  const t = useTranslations('user.security.passkeys')
  const name = passkey.name || t('unnamed')
  return (
    <li className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Key aria-hidden className="shrink-0 text-text-muted" />
        <div className="flex min-w-0 flex-col">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-base text-text">{name}</span>
            {passkey.backedUp && <Badge>{t('synced')}</Badge>}
          </div>
          {passkey.addedAt && (
            <span className="text-xs text-text-muted">{t('addedAt', { time: passkey.addedAt })}</span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <RenamePasskeyDialog id={passkey.id} name={passkey.name ?? ''} />
        <DeletePasskeyDialog id={passkey.id} name={name} />
      </div>
    </li>
  )
}

type AddState =
  | { name: 'loading' }
  | { name: 'ready'; options: PublicKeyCredentialCreationOptionsJSON }
  /** 会话超过 10 分钟（session.freshAge），要重新登录才能添加 */
  | { name: 'reauth' }
  | { name: 'error'; message: string }

/**
 * 添加通行密钥。注册参数在打开对话框时就取好：有的浏览器（Safari）要求在点击的那一刻直接调起通行密钥，
 * 中间不能再等网络请求；会话不够新鲜也能提前知道
 */
function AddPasskeyDialog({ disabled }: { disabled: boolean }) {
  const t = useTranslations('user.security.passkeys')
  const common = useTranslations('common')
  const router = useRouter()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<AddState>({ name: 'loading' })
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const formId = 'add-passkey'

  async function prepare() {
    setState({ name: 'loading' })
    setError(null)
    const { status, data } = await getJson('/api/auth/passkey/generate-register-options')
    if (status === 200) setState({ name: 'ready', options: data as PublicKeyCredentialCreationOptionsJSON })
    else if (authErrorCode(data) === 'SESSION_NOT_FRESH') setState({ name: 'reauth' })
    else setState({ name: 'error', message: t('failed') })
  }

  async function create(values: { name?: string }, options: PublicKeyCredentialCreationOptionsJSON) {
    setPending(true)
    setError(null)
    const name = values.name?.trim() ?? ''
    let response
    try {
      response = await startRegistration({ optionsJSON: options })
    } catch (failure) {
      setPending(false)
      const reason = webAuthnFailure(failure)
      setError(reason === 'duplicate' ? t('duplicate') : reason === 'cancelled' ? t('cancelled') : t('failed'))
      // 注册参数里的挑战只能用一次，换一份再试
      void prepare()
      return
    }
    const { status } = await postJson('/api/auth/passkey/verify-registration', {
      response,
      ...(name ? { name } : {}),
    })
    setPending(false)
    if (status === 200) {
      setOpen(false)
      toast.show({ tone: 'success', title: t('added', { name: name || t('unnamed') }) })
      router.refresh()
      return
    }
    setError(t('failed'))
    void prepare()
  }

  const message = error ?? (state.name === 'error' ? state.message : null)

  async function reauthenticate() {
    setPending(true)
    await postJson('/api/auth/sign-out', {})
    // 整页跳转，丢掉客户端缓存的已登录页面
    window.location.assign(`/sign-in?next=${encodeURIComponent('/user/security')}`)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) void prepare()
      }}
      trigger={<Button disabled={disabled}>{t('add')}</Button>}
      title={state.name === 'reauth' ? t('reauthTitle') : t('add')}
      description={state.name === 'reauth' ? t('reauthDescription') : t('addDescription')}
      actions={
        <>
          <DialogClose>{common('cancel')}</DialogClose>
          {state.name === 'reauth' ? (
            <Button variant="primary" loading={pending} onClick={() => void reauthenticate()}>
              {t('reauth')}
            </Button>
          ) : (
            <Button
              type="submit"
              form={formId}
              variant="primary"
              loading={pending || state.name === 'loading'}
              disabled={state.name === 'error'}
            >
              {t('create')}
            </Button>
          )}
        </>
      }
    >
      {state.name !== 'reauth' && (
        <Form
          id={formId}
          onFormSubmit={(values) => {
            if (state.name === 'ready') void create(values, state.options)
          }}
        >
          {message && <Alert tone="danger">{message}</Alert>}
          <Field label={t('name')} name="name">
            <Input maxLength={NAME_MAX_LENGTH} placeholder={t('namePlaceholder')} autoComplete="off" />
          </Field>
        </Form>
      )}
    </Dialog>
  )
}

function RenamePasskeyDialog({ id, name }: { id: string; name: string }) {
  const t = useTranslations('user.security.passkeys')
  const common = useTranslations('common')
  const router = useRouter()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const formId = `rename-passkey-${id}`

  async function submit(values: { name?: string }) {
    setPending(true)
    setError(null)
    const { status } = await postJson('/api/auth/passkey/update-passkey', { id, name: values.name?.trim() ?? '' })
    setPending(false)
    if (status === 200) {
      setOpen(false)
      toast.show({ tone: 'success', title: t('renamed') })
      router.refresh()
      return
    }
    setError(t('failed'))
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setError(null)
      }}
      trigger={<Button size="sm">{t('rename')}</Button>}
      title={t('renameTitle')}
      actions={
        <>
          <DialogClose>{common('cancel')}</DialogClose>
          <Button type="submit" form={formId} variant="primary" loading={pending}>
            {t('renameSubmit')}
          </Button>
        </>
      }
    >
      <Form id={formId} onFormSubmit={(values) => void submit(values)}>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label={t('name')} name="name">
          <Input defaultValue={name} maxLength={NAME_MAX_LENGTH} required autoComplete="off" />
        </Field>
      </Form>
    </Dialog>
  )
}

function DeletePasskeyDialog({ id, name }: { id: string; name: string }) {
  const t = useTranslations('user.security.passkeys')
  const common = useTranslations('common')
  const router = useRouter()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)

  async function remove() {
    setPending(true)
    const { status } = await postJson('/api/auth/passkey/delete-passkey', { id })
    setPending(false)
    setOpen(false)
    toast.show(
      status === 200 ? { tone: 'success', title: t('deleted', { name }) } : { tone: 'danger', title: t('failed') },
    )
    router.refresh()
  }

  return (
    <Dialog
      alert
      open={open}
      onOpenChange={setOpen}
      trigger={<Button size="sm">{t('delete')}</Button>}
      title={t('deleteTitle', { name })}
      description={t('deleteDescription')}
      actions={
        <>
          <DialogClose>{common('cancel')}</DialogClose>
          <Button variant="danger" loading={pending} onClick={() => void remove()}>
            {t('deleteConfirm')}
          </Button>
        </>
      }
    />
  )
}
