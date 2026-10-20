'use client'

import { Button, Dialog, DialogClose, useToast } from '@nextskin/ui'
import { useFormatter, useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { Monitor } from 'pixelarticons/react/Monitor.js'
import { useState } from 'react'
import { sendJson } from '../../../lib/api-client'

export interface AuthorizationItem {
  /** oauth_clients.id，取消授权的路径参数 */
  id: number
  name: string
  /** 创建者，公用应用换成它的说明 */
  byline: string
  /** 同意过的权限，已经写成人话 */
  scopes: string[]
  /** 令牌绑定的角色，去重 */
  players: string[]
  /** 已经按页面的语言格式化好的最近一次授权时间 */
  authorizedAt: string
}

/**
 * 已授权的应用（ADR-0037"页面"）：同意记录和没过期的令牌按应用合并。取消授权删掉这个应用拿到的令牌、
 * 同意记录和还没兑换的设备码，不影响启动器登录（authserver 的令牌在上面一块）
 */
export function AuthorizationsPanel({ authorizations }: { authorizations: AuthorizationItem[] }) {
  const t = useTranslations('user.security.authorizations')
  if (!authorizations.length)
    return (
      <p className="rounded-sm border border-dashed border-border-strong px-4 py-6 text-sm text-pretty text-text-muted">
        {t('empty')}
      </p>
    )
  return (
    <ul className="divide-y divide-border rounded-sm border border-border">
      {authorizations.map((item) => (
        <AuthorizationRow key={item.id} item={item} />
      ))}
    </ul>
  )
}

function AuthorizationRow({ item }: { item: AuthorizationItem }) {
  const t = useTranslations('user.security.authorizations')
  const common = useTranslations('common')
  const format = useFormatter()
  const router = useRouter()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)

  async function revoke() {
    setPending(true)
    const { status } = await sendJson('DELETE', `/api/user/authorizations/${item.id}`)
    setPending(false)
    setOpen(false)
    toast.show(
      status === 204
        ? { tone: 'success', title: t('revoked', { name: item.name }) }
        : { tone: 'danger', title: t('failed') },
    )
    router.refresh()
  }

  return (
    <li className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start">
      <div className="flex min-w-0 flex-1 gap-3">
        <Monitor aria-hidden className="shrink-0 text-text-muted" />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 flex-col">
            {/* 应用名是创建者填的，用正文字体（DESIGN.md §4） */}
            <span className="truncate text-base text-text">{item.name}</span>
            <span className="text-xs text-text-muted">
              {item.byline} · {t('authorizedAt', { time: item.authorizedAt })}
            </span>
          </div>
          <span className="text-sm text-text">
            {item.players.length ? t('players', { names: format.list(item.players) }) : t('noPlayers')}
          </span>
          {item.scopes.length > 0 && (
            <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-text-muted">
              {item.scopes.map((scope) => (
                <li key={scope}>{scope}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="flex shrink-0">
        <Dialog
          alert
          open={open}
          onOpenChange={setOpen}
          trigger={<Button size="sm">{t('revoke')}</Button>}
          title={t('revokeTitle', { name: item.name })}
          description={t('revokeDescription')}
          actions={
            <>
              <DialogClose>{common('cancel')}</DialogClose>
              <Button variant="danger" loading={pending} onClick={() => void revoke()}>
                {t('revokeConfirm')}
              </Button>
            </>
          }
        />
      </div>
    </li>
  )
}
