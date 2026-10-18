'use client'

import { Badge, Button, Dialog, DialogClose, Link, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import NextLink from 'next/link'
import { useRouter } from 'next/navigation'
import { Gamepad } from 'pixelarticons/react/Gamepad.js'
import { useState } from 'react'
import { sendJson } from '../../../lib/api-client'

export interface LauncherLoginItem {
  id: number
  /** 令牌绑定的角色；还没选角色时为 null */
  player: string | null
  /** 已经按页面的语言格式化好的签发时间 */
  issuedAt: string
  /** refreshable：有效期过了，启动器下次启动时会自己续期 */
  status: 'valid' | 'refreshable'
}

/** 启动器登录：authserver 签发给启动器的令牌（ADR-0030）。退出一个只删这个令牌，不影响网页登录 */
export function LauncherLoginsPanel({ logins }: { logins: LauncherLoginItem[] }) {
  const t = useTranslations('user.security.launchers')
  if (!logins.length)
    return (
      <p className="rounded-sm border border-dashed border-border-strong px-4 py-6 text-sm text-pretty text-text-muted">
        {t.rich('empty', { link: (chunks) => <Link render={<NextLink href="/user#launcher" />}>{chunks}</Link> })}
      </p>
    )
  return (
    <div className="flex flex-col gap-4">
      <ul className="divide-y divide-border rounded-sm border border-border">
        {logins.map((login) => (
          <LauncherLoginRow key={login.id} login={login} />
        ))}
      </ul>
      <div className="flex">
        <RevokeAllDialog count={logins.length} />
      </div>
    </div>
  )
}

function LauncherLoginRow({ login }: { login: LauncherLoginItem }) {
  const t = useTranslations('user.security.launchers')
  const router = useRouter()
  const toast = useToast()
  const [pending, setPending] = useState(false)

  async function revoke() {
    setPending(true)
    const { status } = await sendJson('DELETE', `/api/user/yggdrasil-tokens/${login.id}`)
    setPending(false)
    toast.show(status === 204 ? { tone: 'success', title: t('revoked') } : { tone: 'danger', title: t('failed') })
    router.refresh()
  }

  return (
    <li className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Gamepad aria-hidden className="shrink-0 text-text-muted" />
        <div className="flex min-w-0 flex-col">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-base text-text">
              {login.player === null ? t('noPlayer') : t('player', { name: login.player })}
            </span>
            {login.status === 'valid' ? <Badge tone="success">{t('valid')}</Badge> : <Badge>{t('refreshable')}</Badge>}
          </div>
          <span className="text-xs text-text-muted">{t('issuedAt', { time: login.issuedAt })}</span>
        </div>
      </div>
      <div className="flex shrink-0">
        <Button size="sm" loading={pending} onClick={() => void revoke()}>
          {t('revoke')}
        </Button>
      </div>
    </li>
  )
}

function RevokeAllDialog({ count }: { count: number }) {
  const t = useTranslations('user.security.launchers')
  const common = useTranslations('common')
  const router = useRouter()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)

  async function revokeAll() {
    setPending(true)
    const { status } = await sendJson('DELETE', '/api/user/yggdrasil-tokens')
    setPending(false)
    setOpen(false)
    toast.show(status === 204 ? { tone: 'success', title: t('revokedAll') } : { tone: 'danger', title: t('failed') })
    router.refresh()
  }

  return (
    <Dialog
      alert
      open={open}
      onOpenChange={setOpen}
      trigger={<Button size="sm">{t('revokeAll')}</Button>}
      title={t('revokeAllTitle', { count })}
      description={t('revokeAllDescription')}
      actions={
        <>
          <DialogClose>{common('cancel')}</DialogClose>
          <Button variant="primary" loading={pending} onClick={() => void revokeAll()}>
            {t('revokeAllConfirm')}
          </Button>
        </>
      }
    />
  )
}
