'use client'

import { Button as BaseButton } from '@base-ui/react/button'
import type { ReactNode } from 'react'
import { cx } from '../cx.ts'
import { focusRing } from '../styles.ts'
import { Tooltip } from '../tooltip/tooltip.tsx'

export interface IconButtonProps extends Omit<
  BaseButton.Props,
  'className' | 'style' | 'render' | 'nativeButton' | 'children' | 'aria-label'
> {
  /** 按钮的名称：既是 aria-label，也是鼠标停留时的提示，例如“复制 UUID” */
  label: string
  /** 24px 的 pixelarticons 图标 */
  children: ReactNode
  /** 32 / 40px，和同一行的 Button 取相同的尺寸 */
  size?: 'sm' | 'md'
  /**
   * 右上角的计数，例如页头铃铛上的未读通知数：0 不显示，超过 99 写 99+。
   * 角标对读屏隐藏，label 里要写出数量，例如“通知，3 条未读”
   */
  count?: number
}

const sizes = {
  sm: 'size-8 pointer-coarse:after:-inset-1.5',
  md: 'size-10 pointer-coarse:after:-inset-0.5',
}

/**
 * 只有图标的按钮，用在空间紧凑处的常见操作，例如复制。没有边框和阴影，悬停时底色混入 12% 的 text。
 * 含义不明显的操作改用带文字的 Button（DESIGN.md §6）
 */
export function IconButton({ label, children, size = 'md', count = 0, ...props }: IconButtonProps) {
  return (
    <Tooltip content={label}>
      <BaseButton
        {...props}
        aria-label={label}
        className={cx(
          'relative grid shrink-0 place-items-center rounded-sm text-text-muted',
          'hover:bg-[color-mix(in_srgb,var(--color-surface)_88%,var(--color-text))] hover:text-text',
          'data-disabled:cursor-not-allowed data-disabled:text-border-strong data-disabled:hover:bg-transparent',
          focusRing,
          // 移动端把点击区域扩到 44px（DESIGN.md §9）
          'pointer-coarse:after:absolute',
          sizes[size],
        )}
      >
        <span aria-hidden className="contents">
          {children}
        </span>
        {count > 0 && (
          // 强调色的方块压在图标右上角，外面一圈 2px 的 surface 把它和图标的笔画隔开
          <span
            aria-hidden
            className="absolute top-0.5 right-0.5 grid h-4 min-w-4 place-items-center rounded-sm bg-accent px-0.5 font-pixel text-pixel-1 text-accent-fg tabular-nums shadow-[0_0_0_2px_var(--color-surface)]"
          >
            {count > 99 ? '99+' : count}
          </span>
        )}
      </BaseButton>
    </Tooltip>
  )
}
