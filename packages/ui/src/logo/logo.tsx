'use client'

import { useRender } from '@base-ui/react/use-render'
import { cx } from '../cx.ts'
import { focusRing } from '../styles.ts'
import { LOGO_MARK_SIZE, logoMarkRects, type LogoMarkColor } from './mark.ts'

export interface LogoProps {
  /** 站点名，取自站点设置 */
  name: string
  /** 每格 3px（后台侧栏、页脚）或 4px（页头） */
  size?: 'sm' | 'md'
  /**
   * 页头的标志一般链接到首页：传框架的链接组件，例如 `render={<NextLink href="/" />}`。
   * 链接不加下划线，键盘聚焦时显示焦点框
   */
  render?: useRender.RenderProp
}

const sizes = {
  sm: { cell: 3, name: 'text-pixel-1', gap: 'gap-2' },
  md: { cell: 4, name: 'text-pixel-2', gap: 'gap-3' },
}

const fills: Record<LogoMarkColor, string> = {
  accent: 'fill-accent',
  'accent-fg': 'fill-accent-fg',
  'text-muted': 'fill-text-muted',
  'border-strong': 'fill-border-strong',
}

const rects = logoMarkRects()

/**
 * 标志：折起来的头，前脸用强调色（DESIGN.md §2.2）。图形按整数倍放大，像素锐利；
 * favicon 由同一份图形生成（scripts/design-sync.ts）
 */
export function Logo({ name, size = 'md', render }: LogoProps) {
  const style = sizes[size]
  const px = LOGO_MARK_SIZE * style.cell
  return useRender({
    defaultTagName: 'span',
    render,
    props: {
      className: cx('inline-flex items-center', style.gap, render && cx('rounded-sm', focusRing)),
      children: (
        <>
          <svg
            aria-hidden
            width={px}
            height={px}
            viewBox={`0 0 ${LOGO_MARK_SIZE} ${LOGO_MARK_SIZE}`}
            shapeRendering="crispEdges"
            className="block shrink-0"
          >
            {rects.map((rect) => (
              <rect
                key={`${rect.x},${rect.y}`}
                x={rect.x}
                y={rect.y}
                width={rect.width}
                height={1}
                className={fills[rect.color]}
              />
            ))}
          </svg>
          <span className={cx('font-pixel text-text', style.name)}>{name}</span>
        </>
      ),
    },
  })
}
