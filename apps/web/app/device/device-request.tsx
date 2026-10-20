'use client'

import { Alert, Button, Link, PlayerHead, PlayerPicker } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import NextLink from 'next/link'
import { useState, type ReactNode } from 'react'
import { apiError, postJson } from '../../lib/api-client'
import { headSrc } from '../../lib/textures'
import { DeviceResult } from './device-result'
import { useDeviceSelection, type DevicePlayer } from './device-selection'

/**
 * 批准页的操作部分（ADR-0037"页面"）：申请了 Select 时先选角色，再授权或拒绝，经 REST 调用领域用例。
 * 处理完就地显示结果，不刷新页面：启动器几秒内就来兑换，设备码随之删掉，刷新会显示成"代码不存在"
 */
export function DeviceRequest({
  userCode,
  clientName,
  players,
  choosePlayer,
  blocked,
  children,
}: {
  readonly userCode: string
  readonly clientName: string
  /** 申请了 Select 时是用户的全部角色，否则为空 */
  readonly players: readonly DevicePlayer[]
  readonly choosePlayer: boolean
  /** 封禁、邮箱没验证时的提示：只能拒绝 */
  readonly blocked: ReactNode
  /** 应用、代码、警告和权限，服务端渲染 */
  readonly children: ReactNode
}) {
  const t = useTranslations('device')
  const { pid, select } = useDeviceSelection()
  const [pending, setPending] = useState<'approve' | 'deny' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<'approved' | 'denied' | null>(null)

  async function submit(action: 'approve' | 'deny') {
    setPending(action)
    setError(null)
    const { status, data } = await postJson(
      `/api/user/device/${action}`,
      action === 'approve' ? { userCode, pid: choosePlayer ? pid : null } : { userCode },
    )
    setPending(null)
    if (status === 204) setDone(action === 'approve' ? 'approved' : 'denied')
    else setError(apiError(data)?.message ?? t('failed'))
  }

  if (done) return <DeviceResult status={done} clientName={clientName} />
  const noPlayers = choosePlayer && !players.length
  return (
    <div className="flex flex-col gap-6">
      {children}
      {choosePlayer && (
        <section aria-labelledby="device-player" className="flex flex-col gap-3">
          <h2 id="device-player" className="text-base font-medium text-text">
            {t('player')}
          </h2>
          {noPlayers ? (
            <Alert>
              {t('noPlayers')} <Link render={<NextLink href="/user/players" />}>{t('createPlayer')}</Link>
            </Alert>
          ) : (
            <>
              <PlayerPicker
                aria-label={t('player')}
                value={pid === null ? null : String(pid)}
                onValueChange={(value) => select(Number(value))}
                disabled={pending !== null}
                options={players.map((player) => ({
                  value: String(player.pid),
                  name: player.name,
                  head: (
                    <PlayerHead
                      src={player.skin ? headSrc(player.skin.hash) : undefined}
                      textureScale={player.skin?.scale}
                      size={32}
                      alt=""
                    />
                  ),
                  description: player.skin ? undefined : t('noSkin'),
                }))}
              />
              <p className="text-sm text-pretty text-text-muted">{t('playerHint')}</p>
            </>
          )}
        </section>
      )}
      {blocked}
      {error && <Alert tone="danger">{error}</Alert>}
      {/* 按钮带 shrink-0，两个 fullWidth 放进 flex 会撑出这一栏，用两列网格平分 */}
      <div className="grid grid-cols-2 gap-3">
        <Button
          variant="primary"
          size="lg"
          fullWidth
          loading={pending === 'approve'}
          disabled={Boolean(blocked) || noPlayers || (choosePlayer && pid === null) || pending === 'deny'}
          onClick={() => void submit('approve')}
        >
          {t('approve')}
        </Button>
        <Button
          size="lg"
          fullWidth
          loading={pending === 'deny'}
          disabled={pending === 'approve'}
          onClick={() => void submit('deny')}
        >
          {t('deny')}
        </Button>
      </div>
    </div>
  )
}
