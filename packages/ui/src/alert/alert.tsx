import { CheckboxOn } from 'pixelarticons/react/CheckboxOn.js'
import { InfoBox } from 'pixelarticons/react/InfoBox.js'
import { SquareAlert } from 'pixelarticons/react/SquareAlert.js'
import { WarningDiamond } from 'pixelarticons/react/WarningDiamond.js'
import type { ReactNode } from 'react'
import { cx } from '../cx.ts'

export interface AlertProps {
  /** info 用中性色：强调色只留给主要按钮、链接和选中态（DESIGN.md §2.1） */
  tone?: 'info' | 'success' | 'warning' | 'danger'
  title?: ReactNode
  /** 说明发生了什么、用户能做什么（DESIGN.md §7） */
  children: ReactNode
}

// 图标形状也不同（警告是菱形），不只靠颜色区分（DESIGN.md §9）
const tones = {
  info: { Icon: InfoBox, color: 'text-text-muted', border: 'border-border', role: 'status' },
  success: { Icon: CheckboxOn, color: 'text-success', border: 'border-success', role: 'status' },
  warning: { Icon: WarningDiamond, color: 'text-warning', border: 'border-warning', role: 'alert' },
  danger: { Icon: SquareAlert, color: 'text-danger', border: 'border-danger', role: 'alert' },
} as const

/** 页面内持续存在的提示。一次性的操作反馈用 Toast，全站公告用 Notice */
export function Alert({ tone = 'info', title, children }: AlertProps) {
  const { Icon, color, border, role } = tones[tone]
  return (
    <div role={role} className={cx('flex gap-3 rounded-sm border bg-surface p-4', border)}>
      <Icon aria-hidden className={cx('shrink-0', color)} />
      <div className="flex min-w-0 flex-col gap-1">
        {title && <p className="text-base font-medium text-text">{title}</p>}
        {/* 没有标题时补 2px，让第一行文字和 24px 的图标居中对齐 */}
        <div className={cx('text-sm text-text', !title && 'pt-0.5')}>{children}</div>
      </div>
    </div>
  )
}
