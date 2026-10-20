'use client'

import { FigurePlaceholder, NameTag, SkinFigure } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { createContext, useContext, useState, type ReactNode } from 'react'
import { figureSrc } from '../../lib/textures'

export interface DevicePlayer {
  pid: number
  name: string
  skin: { hash: string; type: 'steve' | 'alex'; scale: number } | null
}

interface Selection {
  pid: number | null
  select: (pid: number) => void
}

const SelectionContext = createContext<Selection>({ pid: null, select: () => {} })

/** 批准页上选中的角色：表单里选，展台上显示，两处不在同一棵组件树里，经 context 共享 */
export function DeviceSelectionProvider({
  initial,
  children,
}: {
  readonly initial: number | null
  readonly children: ReactNode
}) {
  const [pid, select] = useState(initial)
  return <SelectionContext value={{ pid, select }}>{children}</SelectionContext>
}

export function useDeviceSelection(): Selection {
  return useContext(SelectionContext)
}

/** 展台上站着选中的角色，头顶是名牌；还没选或者不需要选角色时显示 fallback（认证页默认的插图） */
export function DeviceStage({
  players,
  scale,
  fallback,
}: {
  readonly players: readonly DevicePlayer[]
  readonly scale: 4 | 8
  readonly fallback: ReactNode
}) {
  const t = useTranslations('device')
  const { pid } = useDeviceSelection()
  const player = players.find((candidate) => candidate.pid === pid)
  if (!player) return fallback
  return (
    <div className="flex max-w-full flex-col items-center gap-3 px-4">
      <NameTag>{player.name}</NameTag>
      {player.skin ? (
        <SkinFigure
          // 换角色时换掉整个人物，转身的动画不会从上一个角色接着播
          key={player.pid}
          src={figureSrc(player.skin.hash, player.skin.type)}
          type={player.skin.type}
          textureScale={player.skin.scale}
          scale={scale}
          alt={t('figure', { name: player.name })}
          turnOnHover
          loading="eager"
        />
      ) : (
        <FigurePlaceholder scale={scale} label={t('figureEmpty', { name: player.name })} />
      )}
    </div>
  )
}
