'use client'

import { Alert, Badge, Button, Dialog, DialogClose, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useEffect, useState, type ReactElement } from 'react'
import { apiError, postJson, sendJson } from '../../../lib/api-client'
import { signInAgain } from './reauth'

export interface ExternalAccountItem {
  pluginId: string
  providerId: string
  /** 已经按页面的语言翻译好的第三方名称 */
  name: string
  icon: ReactElement
  /** 插件停用了、设置不全：不能绑定，也暂时不能用已有的绑定登录，但可以解绑 */
  available: boolean
  /** 已经按页面的语言格式化好的绑定时间；没有绑定时为 null */
  linkedAt: string | null
}

const path = (account: ExternalAccountItem) =>
  `${encodeURIComponent(account.pluginId)}/${encodeURIComponent(account.providerId)}`

/**
 * 第三方账号（ADR-0034）：绑定要先跳到第三方确认，回来时回到这一页；解绑之后要还剩别的登录方式，
 * 否则接口拒绝，提示先设置密码或添加通行密钥
 */
export function ExternalAccountsPanel({ accounts }: { accounts: readonly ExternalAccountItem[] }) {
  const t = useTranslations('user.security.external')
  const [reauth, setReauth] = useState(false)
  const [pending, setPending] = useState(false)
  return (
    <div className="flex flex-col gap-4">
      {reauth && (
        <Alert tone="warning" title={t('reauthTitle')}>
          <span className="flex flex-col items-start gap-3">
            {t('reauthDescription')}
            <Button
              loading={pending}
              onClick={() => {
                setPending(true)
                void signInAgain()
              }}
            >
              {t('reauth')}
            </Button>
          </span>
        </Alert>
      )}
      <ul className="divide-y divide-border rounded-sm border border-border">
        {accounts.map((account) => (
          <ExternalAccountRow key={path(account)} account={account} onReauth={() => setReauth(true)} />
        ))}
      </ul>
    </div>
  )
}

function ExternalAccountRow({ account, onReauth }: { account: ExternalAccountItem; onReauth: () => void }) {
  const t = useTranslations('user.security.external')
  const toast = useToast()
  const [pending, setPending] = useState(false)

  // 从第三方的页面按返回键回来时，浏览器可能直接恢复跳转前的页面，按钮还停在提交中
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) setPending(false)
    }
    window.addEventListener('pageshow', restored)
    return () => window.removeEventListener('pageshow', restored)
  }, [])

  async function link() {
    setPending(true)
    const { status, data } = await postJson(`/api/external-login/${path(account)}`, { intent: 'link' })
    const url = (data as { url?: unknown } | null)?.url
    if (status === 200 && typeof url === 'string') {
      window.location.assign(url)
      return
    }
    setPending(false)
    const failure = apiError(data)
    if (failure?.code === 'session_not_fresh') onReauth()
    else toast.show({ tone: 'danger', title: failure?.message ?? t('failed') })
  }

  return (
    <li className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="shrink-0 text-text-muted">{account.icon}</span>
        <div className="flex min-w-0 flex-col">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-base text-text">{account.name}</span>
            {account.linkedAt !== null && account.available && <Badge tone="success">{t('linked')}</Badge>}
            {!account.available && <Badge tone="warning">{t('disabled')}</Badge>}
          </div>
          <span className="text-xs text-text-muted">
            {account.linkedAt === null
              ? t('notLinked')
              : account.available
                ? t('linkedAt', { time: account.linkedAt })
                : t('disabledHint', { time: account.linkedAt })}
          </span>
        </div>
      </div>
      <div className="flex shrink-0">
        {account.linkedAt !== null ? (
          <UnlinkDialog account={account} />
        ) : (
          <Button size="sm" loading={pending} onClick={() => void link()}>
            {t('link')}
          </Button>
        )}
      </div>
    </li>
  )
}

function UnlinkDialog({ account }: { account: ExternalAccountItem }) {
  const t = useTranslations('user.security.external')
  const common = useTranslations('common')
  const router = useRouter()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function unlink() {
    setPending(true)
    setError(null)
    const { status, data } = await sendJson('DELETE', `/api/user/bindings/${path(account)}`)
    setPending(false)
    if (status === 200) {
      setOpen(false)
      toast.show({ tone: 'success', title: t('unlinked', { provider: account.name }) })
      router.refresh()
      return
    }
    // 最后一种登录方式这类错误留在对话框里，用户读完再关
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
      trigger={<Button size="sm">{t('unlink')}</Button>}
      title={t('unlinkTitle', { provider: account.name })}
      description={t('unlinkDescription', { provider: account.name })}
      actions={
        <>
          <DialogClose>{common('cancel')}</DialogClose>
          <Button variant="danger" loading={pending} onClick={() => void unlink()}>
            {t('unlinkConfirm', { provider: account.name })}
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
    </Dialog>
  )
}
