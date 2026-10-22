'use client'

import { Popover as BasePopover } from '@base-ui/react/popover'
import type { ReactElement, ReactNode } from 'react'

export interface PopoverProps {
  /** 打开浮层的按钮，例如页头的通知铃铛（带 count 的 IconButton） */
  trigger: ReactElement
  /** 浮层的标题，像素字体，例如“通知” */
  title: ReactNode
  /** 标题右边的一个操作，例如“全部标为已读”的小号 IconButton */
  action?: ReactNode
  /** 浮层的内容，超过视口时在浮层里滚动 */
  children: ReactNode
  /** 底部的一行，例如“查看全部”的链接 */
  footer?: ReactNode
  /** 浮层和触发按钮哪一边对齐。页头右上角用 end，免得伸出屏幕 */
  align?: 'start' | 'end'
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

/**
 * 轻量的浮层：点开看一眼补充内容，不打断当前流程，例如页头的“最近的通知”。点外面或按 Esc 关闭，焦点回到触发按钮。
 * 浮层里不放要提交的表单（改用 Dialog），也不放一组菜单项（改用 Menu）
 */
export function Popover({
  trigger,
  title,
  action,
  children,
  footer,
  align = 'start',
  open,
  onOpenChange,
}: PopoverProps) {
  return (
    <BasePopover.Root open={open} onOpenChange={onOpenChange ? (next) => onOpenChange(next) : undefined}>
      <BasePopover.Trigger render={trigger} />
      <BasePopover.Portal>
        <BasePopover.Positioner className="z-30 outline-none" sideOffset={8} align={align} collisionPadding={16}>
          <BasePopover.Popup
            className={
              // 渲染在 body 下，字体自己设。和 Menu 一样是四格阶跃的淡入；窄屏两边各留 16px
              'flex max-h-(--available-height) w-80 max-w-[calc(100vw-2rem)] flex-col rounded-md border border-border-strong bg-surface-raised font-sans text-text shadow-pixel-lg outline-none transition-opacity duration-fast ease-step motion-reduce:transition-none data-ending-style:opacity-0 data-starting-style:opacity-0'
            }
          >
            <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border pr-2 pl-4">
              <BasePopover.Title className="font-pixel text-pixel-1 text-text">{title}</BasePopover.Title>
              {action}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
            {footer && <div className="shrink-0 border-t border-border px-4 py-3 text-sm">{footer}</div>}
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  )
}
