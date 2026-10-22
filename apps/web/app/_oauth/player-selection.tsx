'use client'

import { Alert, FigurePlaceholder, Link, NameTag, PlayerHead, PlayerPicker, SkinFigure } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import NextLink from 'next/link'
import { createContext, useContext, useState, type ReactNode } from 'react'
import { figureSrc, headSrc } from '../../lib/textures'

export interface AuthorizationPlayer {
  pid: number
  name: string
  skin: { hash: string; type: 'steve' | 'alex'; scale: number } | null
}

interface Selection {
  pid: number | null
  select: (pid: number) => void
}

const SelectionContext = createContext<Selection>({ pid: null, select: () => {} })

/** 授权页上选中的角色：表单里选，展台上显示，两处不在同一棵组件树里，经 context 共享 */
export function PlayerSelectionProvider({
  initial,
  children,
}: {
  readonly initial: number | null
  readonly children: ReactNode
}) {
  const [pid, select] = useState(initial)
  return <SelectionContext value={{ pid, select }}>{children}</SelectionContext>
}

export function usePlayerSelection(): Selection {
  return useContext(SelectionContext)
}

/** 展台上站着选中的角色，头顶是名牌；还没选或者不需要选角色时显示 fallback（认证页默认的插图） */
export function PlayerStage({
  players,
  scale,
  fallback,
}: {
  readonly players: readonly AuthorizationPlayer[]
  readonly scale: 4 | 8
  readonly fallback: ReactNode
}) {
  const t = useTranslations('oauth')
  const { pid } = usePlayerSelection()
  const player = players.find((candidate) => candidate.pid === pid)
  if (!player) return fallback
  return (
    <div className="flex max-w-full flex-col items-center gap-3 px-4">
      <NameTag>{player.name}</NameTag>
      {player.skin ? (
        <SkinFigure
          // 换角色时换掉整个人物，抬手的动画不会从上一个角色接着播
          key={player.pid}
          src={figureSrc(player.skin.hash, player.skin.type)}
          type={player.skin.type}
          textureScale={player.skin.scale}
          scale={scale}
          alt={t('figure', { name: player.name })}
          view="front"
          raiseOnHover
          loading="eager"
        />
      ) : (
        <FigurePlaceholder scale={scale} view="front" label={t('figureEmpty', { name: player.name })} />
      )}
    </div>
  )
}

/** 申请了 Select 时的"选择角色"一节（ADR-0037"角色绑定"）；没有角色时引导去创建 */
export function PlayerField({
  players,
  disabled,
}: {
  readonly players: readonly AuthorizationPlayer[]
  readonly disabled: boolean
}) {
  const t = useTranslations('oauth')
  const { pid, select } = usePlayerSelection()
  return (
    <section aria-labelledby="authorization-player" className="flex flex-col gap-3">
      <h2 id="authorization-player" className="text-base font-medium text-text">
        {t('player')}
      </h2>
      {players.length ? (
        <>
          <PlayerPicker
            aria-label={t('player')}
            value={pid === null ? null : String(pid)}
            onValueChange={(value) => select(Number(value))}
            disabled={disabled}
            options={players.map((player) => ({
              value: String(player.pid),
              name: player.name,
              head: (
                <PlayerHead
                  src={player.skin ? headSrc(player.skin.hash) : undefined}
                  fallback="blank"
                  size={32}
                  alt=""
                />
              ),
              description: player.skin ? undefined : t('noSkin'),
            }))}
          />
          <p className="text-sm text-pretty text-text-muted">{t('playerHint')}</p>
        </>
      ) : (
        <Alert>
          {t('noPlayers')} <Link render={<NextLink href="/user/players" />}>{t('createPlayer')}</Link>
        </Alert>
      )}
    </section>
  )
}
