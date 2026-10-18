'use client'

import { useRender } from '@base-ui/react/use-render'
import type { ReactNode } from 'react'
import { cx } from '../cx.ts'
import { FigurePlaceholder } from '../figure-placeholder/figure-placeholder.tsx'
import { NameTag } from '../name-tag/name-tag.tsx'
import { focusRing, stageGrid } from '../styles.ts'

export interface PodiumPlace {
  /** 名牌上的材质名。用户产生的内容，用正文字体（DESIGN.md §4） */
  name: string
  /** ×5 的 SkinFigure */
  figure: ReactNode
  /** 台阶上名次下面的一行，例如“♥ +214” */
  score: string
  /** 链接的名字，把名次、材质名和数字说全，例如“第 1 名：雪色双马尾，最近 7 天 214 人收藏” */
  label: string
  /** 去材质详情的链接，传框架的链接组件，例如 `<NextLink href="/skinlib/12" />` */
  render: useRender.RenderProp
}

export interface PodiumProps {
  /** 展台左上角的标题，例如“本周收藏最多” */
  title: string
  /** 标题的层级，按页面的标题结构选 */
  headingLevel?: 'h2' | 'h3'
  /** 标题右边的时间范围，例如“10.12 – 10.18” */
  period?: string
  /** 按名次排好的前三名，可以不满三个 */
  places: PodiumPlace[]
  /** 空着的名次上人形剪影的替代文字，例如“这个名次还空着” */
  vacantLabel: string
  /** 一个都没有时标题下面的一行，例如去皮肤库看看的链接 */
  empty?: ReactNode
}

const RANKS = [1, 2, 3] as const
// 台阶从左到右是第二、第一、第三名（DESIGN.md §2.2）；读屏软件按名次的顺序读
const steps = {
  1: { order: 'order-2', height: 'h-26' },
  2: { order: 'order-1', height: 'h-20' },
  3: { order: 'order-3', height: 'h-16' },
}

/**
 * 首页的领奖台：前三名的皮肤站在台阶上，头顶有名牌，台阶上写名次和数字（DESIGN.md §2.2）。
 * 鼠标移到角色上或键盘聚焦时转身；不满三个时，空着的台阶上放人形剪影
 */
export function Podium({ title, headingLevel: Heading = 'h2', period, places, vacantLabel, empty }: PodiumProps) {
  return (
    <div className={cx('flex flex-col gap-3 overflow-hidden rounded-md border border-border bg-stage', stageGrid)}>
      <div className="flex items-baseline justify-between gap-3 px-4 pt-4 font-pixel text-pixel-1 sm:px-6 sm:pt-5">
        <Heading className="text-text">{title}</Heading>
        {period && <span className="text-text-muted tabular-nums">{period}</span>}
      </div>
      {places.length === 0 && empty && <p className="px-4 text-sm text-pretty text-text-muted sm:px-6">{empty}</p>}
      <ol className="flex items-end justify-center gap-2 px-4 pt-2 sm:px-6">
        {RANKS.map((rank) => {
          const place = places[rank - 1]
          return (
            <li key={rank} className={cx('flex w-24 min-w-0 flex-col items-center sm:w-30', steps[rank].order)}>
              {place ? <PlaceLink place={place} /> : <FigurePlaceholder scale={5} label={vacantLabel} />}
              {/* 名次和数字已经在链接的名字里，读屏软件不再读台阶 */}
              <div
                aria-hidden
                className={cx(
                  'flex w-full flex-col items-center gap-1 pt-3 font-pixel tabular-nums',
                  steps[rank].height,
                  rank === 1
                    ? 'bg-accent text-accent-fg'
                    : 'border border-b-0 border-border-strong bg-surface text-text',
                )}
              >
                <span className="text-pixel-2">{rank}</span>
                {place && <span className="text-pixel-1">{place.score}</span>}
              </div>
            </li>
          )
        })}
      </ol>
      {/* 地面：台阶站在一条深色的线上 */}
      <div aria-hidden className="-mt-3 h-3 border-t-4 border-border-strong bg-surface-sunken" />
    </div>
  )
}

function PlaceLink({ place }: { place: PodiumPlace }) {
  return useRender({
    defaultTagName: 'a',
    render: place.render,
    props: {
      'aria-label': place.label,
      // 链接带 group/turn：鼠标移上去或键盘聚焦时皮肤转身（SkinFigure）
      className: cx('group/turn flex max-w-full flex-col items-center gap-2 rounded-sm', focusRing),
      children: (
        <>
          <NameTag>{place.name}</NameTag>
          {place.figure}
        </>
      ),
    },
  })
}
