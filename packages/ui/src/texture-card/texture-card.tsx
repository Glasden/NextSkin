'use client'

import { mergeProps } from '@base-ui/react/merge-props'
import { useRender } from '@base-ui/react/use-render'
import { Check } from 'pixelarticons/react/Check.js'
import type { ReactNode } from 'react'
import { cx } from '../cx.ts'
import { focusRing } from '../styles.ts'

export interface TextureCardProps extends Omit<useRender.ComponentProps<'a'>, 'className' | 'style' | 'children'> {
  /** 材质名，或衣柜里给这件起的名字。用户产生的内容，用正文字体（DESIGN.md §4） */
  name: string
  /** 标题的层级，按页面的标题结构选 */
  headingLevel?: 'h2' | 'h3'
  /** 展台上的材质：×4 的 SkinFigure */
  figure: ReactNode
  /** 名字下面一行的信息，例如“Alex · 12 人收藏” */
  meta?: ReactNode
  /** 跟在名字后面的状态，例如“私有”的 Badge */
  badge?: ReactNode
  /** 选中时的说明，例如“已在衣柜”。传了就显示为选中：加粗的强调色边框加左上角的勾选角标，不只靠颜色区分 */
  selected?: string
  /** 右上角的操作，例如“更多”的 Menu。放在链接之外，点它不会跳转 */
  actions?: ReactNode
}

// 悬停时卡片抬起：向左上挪 2px，露出 4px 的硬边阴影（DESIGN.md §2）。右上角的操作和卡片一起挪
const lift = cx(
  'transition-[translate,box-shadow] duration-fast ease-step motion-reduce:transition-none',
  'group-hover/card:-translate-x-0.5 group-hover/card:-translate-y-0.5',
)
// 链接自己也带 group/turn：键盘聚焦它时皮肤转身（SkinFigure 看的是 group/turn 上的 focus-visible）
const cardClass = cx(
  'group/turn flex h-full min-w-0 flex-col overflow-hidden rounded-md border border-border bg-surface',
  'group-hover/card:shadow-pixel-lg',
  lift,
  focusRing,
)
// 选中：再画一圈向内的 2px 描边，和 1px 的边框叠成 2px 的强调色边，布局不跳动。键盘聚焦时让位给焦点框
const selectedClass = 'border-accent outline-2 -outline-offset-2 outline-accent'

/**
 * 皮肤库、衣柜里的一件材质：上面是展台，下面是名字和信息，整张卡片是去详情页的链接。
 * 鼠标移上去或键盘聚焦时，展台上的皮肤转身。站内跳转用 render 换成框架的链接组件，
 * 例如 `render={<NextLink href="/skinlib/12" />}`
 */
export function TextureCard({
  name,
  headingLevel: Heading = 'h2',
  figure,
  meta,
  badge,
  selected,
  actions,
  render,
  ...props
}: TextureCardProps) {
  const link = useRender({
    defaultTagName: 'a',
    render,
    props: mergeProps<'a'>(
      {
        className: cx(cardClass, selected && selectedClass),
        children: (
          <>
            <span className="relative grid h-40 place-items-center border-b border-border bg-stage">
              {figure}
              {selected && (
                <span className="absolute top-0 left-0 grid size-6 place-items-center rounded-br-sm bg-accent text-accent-fg">
                  <Check aria-hidden />
                  <span className="sr-only">{selected}</span>
                </span>
              )}
            </span>
            <span className="flex min-w-0 flex-col gap-1 px-3 py-2">
              <span className="flex min-w-0 items-center gap-2">
                <Heading className="min-w-0 truncate text-base font-medium text-text">{name}</Heading>
                {badge}
              </span>
              {meta && <span className="flex min-w-0 items-center gap-2 text-sm text-text-muted">{meta}</span>}
            </span>
          </>
        ),
      },
      props,
    ),
  })
  return (
    // 外层也带 group/turn：鼠标停在右上角的操作上时，皮肤不转回去
    <article className="group/card group/turn relative min-w-0">
      {link}
      {actions && <div className={cx('absolute top-2 right-2', lift)}>{actions}</div>}
    </article>
  )
}
