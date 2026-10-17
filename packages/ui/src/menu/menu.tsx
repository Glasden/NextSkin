'use client'

import { Menu as BaseMenu } from '@base-ui/react/menu'
import { ChevronDown } from 'pixelarticons/react/ChevronDown.js'
import type { ReactElement, ReactNode } from 'react'
import { cx } from '../cx.ts'
import { focusRing } from '../styles.ts'

export interface MenuProps {
  /** 触发按钮上的文字，例如当前用户的昵称 */
  label: ReactNode
  /** MenuItem、MenuLinkItem、MenuSeparator */
  children: ReactNode
  /** 菜单和触发按钮哪一边对齐。页头右上角的菜单用 end，免得伸出屏幕 */
  align?: 'start' | 'end'
}

// 悬停和高亮都是底色混入 12% 的 text（DESIGN.md §2）
const hover = 'hover:bg-[color-mix(in_srgb,var(--color-surface)_88%,var(--color-text))]'
const highlighted = 'data-highlighted:bg-[color-mix(in_srgb,var(--color-surface-raised)_88%,var(--color-text))]'

/**
 * 下拉菜单：一组跳转和操作，例如页头的用户菜单。方向键在菜单项之间移动，Esc 关闭，焦点回到触发按钮。
 * 菜单项少于两个时直接放按钮或链接
 */
export function Menu({ label, children, align = 'start' }: MenuProps) {
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger
        className={cx(
          'inline-flex h-10 max-w-full items-center gap-1 rounded-sm pr-1 pl-3 text-sm font-medium text-text select-none',
          hover,
          'data-popup-open:bg-[color-mix(in_srgb,var(--color-surface)_88%,var(--color-text))]',
          focusRing,
        )}
      >
        <span className="truncate">{label}</span>
        <ChevronDown aria-hidden className="shrink-0" />
      </BaseMenu.Trigger>
      <BaseMenu.Portal>
        <BaseMenu.Positioner className="z-10 outline-none" sideOffset={8} align={align} collisionPadding={16}>
          <BaseMenu.Popup
            className={cx(
              // 渲染在 body 下，字体自己设。弹出是四格阶跃的淡入
              'min-w-48 rounded-md border border-border-strong bg-surface-raised py-1 font-sans text-text shadow-pixel-lg outline-none',
              'transition-opacity duration-fast ease-step motion-reduce:transition-none data-ending-style:opacity-0 data-starting-style:opacity-0',
            )}
          >
            {children}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  )
}

const itemClass = cx(
  'flex h-10 cursor-default items-center gap-3 px-3 text-sm text-text outline-none select-none',
  highlighted,
  'data-disabled:text-text-muted',
)

export interface MenuItemProps {
  children: ReactNode
  onClick?: () => void
  /** 24px 的 pixelarticons 图标，放在文字前面 */
  icon?: ReactNode
  disabled?: boolean
}

/** 执行一个操作，例如“退出登录”。点了以后菜单关闭 */
export function MenuItem({ children, onClick, icon, disabled }: MenuItemProps) {
  return (
    <BaseMenu.Item className={itemClass} onClick={onClick} disabled={disabled}>
      {icon && <span className="shrink-0 text-text-muted">{icon}</span>}
      {children}
    </BaseMenu.Item>
  )
}

export interface MenuLinkItemProps {
  children: ReactNode
  /** 站内跳转传框架的链接组件，例如 `render={<NextLink href="/user" />}` */
  render?: ReactElement
  href?: string
  icon?: ReactNode
}

/** 跳转到其他页面 */
export function MenuLinkItem({ children, render, href, icon }: MenuLinkItemProps) {
  return (
    <BaseMenu.LinkItem className={itemClass} render={render} href={href} closeOnClick>
      {icon && <span className="shrink-0 text-text-muted">{icon}</span>}
      {children}
    </BaseMenu.LinkItem>
  )
}

/** 分隔两组菜单项 */
export function MenuSeparator() {
  return <BaseMenu.Separator className="my-1 h-px bg-border" />
}
