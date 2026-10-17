import type { ReactNode } from 'react'

export interface EmptyStateProps {
  /** pixelarticons 图标，显示成 48px（24 格的图标只在 24px、48px 时清晰，DESIGN.md §5） */
  icon: ReactNode
  title: ReactNode
  /** 说明为什么是空的（DESIGN.md §7） */
  description?: ReactNode
  /** 一个下一步操作，例如“添加角色”按钮或“去皮肤库看看”链接 */
  action?: ReactNode
}

/** 列表为空时占据列表的位置：说明为什么是空的，并给出下一步操作。宽度占满父元素 */
export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-4 rounded-md border border-dashed border-border-strong px-6 py-12 text-center">
      <span aria-hidden className="text-text-muted [&>svg]:size-12">
        {icon}
      </span>
      <div className="flex max-w-sm flex-col gap-2">
        <p className="text-lg font-medium text-text">{title}</p>
        {description && <p className="text-sm text-pretty text-text-muted">{description}</p>}
      </div>
      {action && <div className="pt-2">{action}</div>}
    </div>
  )
}
