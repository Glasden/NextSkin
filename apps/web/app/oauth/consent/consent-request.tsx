'use client'

import { Alert, Button, Link } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useEffect, useState, type ReactNode } from 'react'
import { postJson, sendJson } from '../../../lib/api-client'
import { PlayerField, usePlayerSelection, type AuthorizationPlayer } from '../../_oauth/player-selection'

/** 选角色的请求头：consent 的钩子按它把角色写进同意记录和授权码（ADR-0037"角色绑定"） */
const PLAYER_HEADER = 'X-NextSkin-Player'

/**
 * 同意页的操作部分（ADR-0037"页面"）：申请了 Select 时先选角色，再同意或拒绝。两个请求都发给 Better Auth 的
 * `/oauth2/consent`（只收 JSON），oauth_query 是页面地址上签过名的参数。响应是要去的地址：带着授权码或
 * access_denied 回到应用，整页跳过去
 */
export function ConsentRequest({
  oauthQuery,
  players,
  choosePlayer,
  blocked,
  children,
}: {
  readonly oauthQuery: string
  /** 申请了 Select 时是用户的全部角色，否则为空 */
  readonly players: readonly AuthorizationPlayer[]
  readonly choosePlayer: boolean
  /** 封禁、邮箱没验证时的提示：只能拒绝 */
  readonly blocked: ReactNode
  /** 标题、应用和权限，服务端渲染 */
  readonly children: ReactNode
}) {
  const t = useTranslations('oauth')
  const { pid } = usePlayerSelection()
  const [pending, setPending] = useState<'accept' | 'deny' | null>(null)
  const [error, setError] = useState<string | null>(null)

  // 跳到应用之后按返回键回来，浏览器可能直接恢复跳转前的页面，按钮还停在提交中
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) setPending(null)
    }
    window.addEventListener('pageshow', restored)
    return () => window.removeEventListener('pageshow', restored)
  }, [])

  async function submit(accept: boolean) {
    setPending(accept ? 'accept' : 'deny')
    setError(null)
    // 拒绝不带 scope：Better Auth 先比较 scope、再看是否同意
    const { status, data } = await sendJson(
      'POST',
      '/api/auth/oauth2/consent',
      { accept, oauth_query: oauthQuery },
      { headers: accept && choosePlayer && pid !== null ? { [PLAYER_HEADER]: String(pid) } : {} },
    )
    const url = (data as { url?: unknown } | null)?.url
    if (status === 200 && typeof url === 'string') {
      // 跳转之前按钮一直保持提交中
      window.location.assign(url)
      return
    }
    const code = (data as { error?: unknown } | null)?.error
    setError(
      status === 401 ? t('consent.sessionExpired') : code === 'invalid_signature' ? t('consent.expired') : t('failed'),
    )
    setPending(null)
  }

  const noPlayers = choosePlayer && !players.length
  return (
    <div className="flex flex-col gap-6">
      {children}
      {choosePlayer && <PlayerField players={players} disabled={pending !== null} />}
      {blocked}
      {error && <Alert tone="danger">{error}</Alert>}
      {/* 按钮带 shrink-0，两个 fullWidth 放进 flex 会撑出这一栏，用两列网格平分 */}
      <div className="grid grid-cols-2 gap-3">
        <Button
          variant="primary"
          size="lg"
          fullWidth
          loading={pending === 'accept'}
          disabled={Boolean(blocked) || noPlayers || (choosePlayer && pid === null) || pending === 'deny'}
          onClick={() => void submit(true)}
        >
          {t('approve')}
        </Button>
        <Button
          size="lg"
          fullWidth
          loading={pending === 'deny'}
          disabled={pending === 'accept'}
          onClick={() => void submit(false)}
        >
          {t('deny')}
        </Button>
      </div>
    </div>
  )
}

/**
 * "换一个账号"：退出登录，带着同一份签名参数去登录页，登录以后经授权地址回到这里。看起来是链接（去登录页），
 * 先要发一个退出登录的请求，所以渲染成按钮。替换掉这一页：已经退出登录，按后退回来只能看到失效的同意页
 */
export function SwitchAccount({ oauthQuery }: { readonly oauthQuery: string }) {
  const t = useTranslations('oauth.consent')
  const [pending, setPending] = useState(false)
  async function switchAccount() {
    if (pending) return
    setPending(true)
    await postJson('/api/auth/sign-out', {})
    window.location.replace(`/sign-in?${oauthQuery}`)
  }
  return (
    <Link render={<button type="button" aria-busy={pending} onClick={() => void switchAccount()} />}>
      {t('switchAccount')}
    </Link>
  )
}
