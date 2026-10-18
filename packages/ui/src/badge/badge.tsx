import type { ReactNode } from 'react'
import { cx } from '../cx.ts'

export interface BadgeProps {
  /**
   * neutral：没有好坏之分的状态，例如“未开启”；success、warning、danger 和 Alert 的语义相同。
   * 不提供强调色：强调色只留给主要按钮、链接和选中态（DESIGN.md §2.1）
   */
  tone?: 'neutral' | 'success' | 'warning' | 'danger'
  /** 固定文案，例如“已开启”“未验证”。用像素字体，所以不放用户产生的内容（DESIGN.md §4） */
  children: ReactNode
}

const tones = {
  neutral: 'border-border-strong text-text-muted',
  success: 'border-success text-success',
  warning: 'border-warning text-warning',
  danger: 'border-danger text-danger',
}

/**
 * 跟在标题或列表项后面的短状态。文字本身说明状态，颜色只是辅助（DESIGN.md §9）。
 * 高 24px，和行内的 24px 图标对齐
 */
export function Badge({ tone = 'neutral', children }: BadgeProps) {
  return (
    <span
      className={cx(
        'inline-flex h-6 shrink-0 items-center rounded-sm border bg-surface px-1.5 font-pixel text-pixel-1 whitespace-nowrap',
        tones[tone],
      )}
    >
      {children}
    </span>
  )
}
