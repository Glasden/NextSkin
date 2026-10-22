'use client'

import { Alert, Badge, Button, Dialog, DialogClose, Link, PlayerHead, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import NextLink from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { apiError, sendJson } from '../../../lib/api-client'
import { headSrc } from '../../../lib/textures'

/** 选角色时列出的一个角色：头像用它现在的皮肤 */
export interface ApplyPlayer {
  pid: number
  name: string
  skin: number | null
  cape: number | null
  head: { hash: string; scale: number } | null
}

export interface ApplyTextureDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  texture: { tid: number; name: string; type: 'steve' | 'alex' | 'cape' }
  players: readonly ApplyPlayer[]
  /** 开着“必须验证邮箱”而用户还没验证：换材质属于角色管理（ADR-0026） */
  locked: boolean
}

/** 把衣柜里的一件换到某个角色上：衣柜页和材质详情页共用。每个角色一行，点“换上”就生效 */
export function ApplyTextureDialog({ open, onOpenChange, texture, players, locked }: ApplyTextureDialogProps) {
  const t = useTranslations('user.closet.apply')
  const closet = useTranslations('user.closet')
  const common = useTranslations('common')
  const router = useRouter()
  const toast = useToast()
  const [pending, setPending] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const slot = texture.type === 'cape' ? 'cape' : 'skin'

  async function apply(player: ApplyPlayer) {
    setPending(player.pid)
    setError(null)
    const { status, data } = await sendJson('PATCH', `/api/players/${player.pid}`, { [slot]: texture.tid })
    setPending(null)
    if (status === 200) {
      toast.show({ tone: 'success', title: t('applied', { player: player.name, name: texture.name }) })
      onOpenChange(false)
      router.refresh()
      return
    }
    setError(apiError(data)?.message ?? closet('failed'))
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) setError(null)
      }}
      title={t('title', { slot, name: texture.name })}
      description={players.length ? t('description') : undefined}
      actions={<DialogClose>{common('close')}</DialogClose>}
    >
      {error && <Alert tone="danger">{error}</Alert>}
      {locked && <Alert tone="warning">{t('verifyFirst')}</Alert>}
      {players.length ? (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {players.map((player) => {
            const current = player[slot] === texture.tid
            return (
              <li key={player.pid} className="flex items-center gap-3 px-3 py-2">
                <PlayerHead
                  src={player.head ? headSrc(player.head.hash) : undefined}
                  fallback="blank"
                  size={32}
                  alt=""
                />
                <span className="min-w-0 flex-1 truncate text-base text-text">{player.name}</span>
                {current ? (
                  <Badge tone="success">{t('current')}</Badge>
                ) : (
                  <Button
                    size="sm"
                    disabled={locked || (pending !== null && pending !== player.pid)}
                    loading={pending === player.pid}
                    onClick={() => void apply(player)}
                  >
                    {t('apply')}
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      ) : (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-text">{t('noPlayers')}</p>
          <Link render={<NextLink href="/user/players" />}>{t('addPlayer')}</Link>
        </div>
      )}
    </Dialog>
  )
}
