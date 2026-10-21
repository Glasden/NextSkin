import { InfoBox } from 'pixelarticons/react/InfoBox.js'
import type { ReactNode } from 'react'
import { cx } from '../cx.ts'

export interface NoticeProps {
  /** 地标的名字，读屏软件按它跳转，例如“维护提示” */
  label: string
  /** 一两句话：现在是什么状态、会影响谁 */
  children: ReactNode
  /** 放在右边的一个链接，例如去对应的设置 */
  action?: ReactNode
  /** 24px 的 pixelarticons 图标，默认是信息框 */
  icon?: ReactNode
  /** 后台的正文更宽（ADR-0027），和 SiteHeader 的 wide 一致，左右才对得齐 */
  wide?: boolean
}

/**
 * 全站提示条，放在页头下方，和页头一样宽，跟着页面滚走。强调色淡底（DESIGN.md §3 的公告条）；
 * 不是实时区域：每打开一个页面都会出现，读出来只会打扰。只和当前页面有关的提示用 Alert
 */
export function Notice({ label, children, action, icon, wide = false }: NoticeProps) {
  return (
    <aside aria-label={label} className="@container border-b border-border bg-accent-subtle">
      <div
        className={cx(
          'mx-auto flex w-full flex-wrap items-start gap-x-3 gap-y-1 px-4 py-2 sm:px-6 @lg:flex-nowrap',
          wide ? 'max-w-7xl' : 'max-w-6xl',
        )}
      >
        <span aria-hidden className="flex shrink-0 text-accent">
          {icon ?? <InfoBox />}
        </span>
        {/* 补 2px，让第一行文字和 24px 的图标居中对齐 */}
        <p className="min-w-0 flex-1 pt-0.5 text-sm text-pretty text-text">{children}</p>
        {/* 提示条窄的时候链接换到第二行，和文字左对齐（图标 24px 加 12px 的间距）。按容器的宽度判断，不按视口 */}
        {action && <div className="w-full pl-9 text-sm @lg:w-auto @lg:shrink-0 @lg:pt-0.5 @lg:pl-0">{action}</div>}
      </div>
    </aside>
  )
}
