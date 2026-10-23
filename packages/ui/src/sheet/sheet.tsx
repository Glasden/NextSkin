'use client'

import { Drawer } from '@base-ui/react/drawer'
import { Close } from 'pixelarticons/react/Close.js'
import type { ReactElement, ReactNode } from 'react'
import { cx } from '../cx.ts'
import { IconButton } from '../icon-button/icon-button.tsx'

export interface SheetProps {
  /** 打开侧边栏的按钮，例如窄屏页头的“打开导航”（IconButton）。不传时用 open 和 onOpenChange 控制 */
  trigger?: ReactElement
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** 从哪一边滑出来：start 放导航，end 放详情 */
  side?: 'start' | 'end'
  /** 顶栏左边的标题，像素字体，例如材质名；导航的侧边栏放链接到首页的 Logo */
  title: ReactNode
  /** 右上角关闭按钮的名称，例如“关闭导航” */
  closeLabel: string
  /** 侧边栏的内容，超过视口时在栏里滚动 */
  children: ReactNode
}

const sides = {
  start: {
    viewport: 'justify-start',
    popup: 'border-r data-ending-style:-translate-x-full data-starting-style:-translate-x-full',
    swipe: 'left',
  },
  end: {
    viewport: 'justify-end',
    popup: 'border-l data-ending-style:translate-x-full data-starting-style:translate-x-full',
    swipe: 'right',
  },
} as const

/**
 * 从屏幕一边滑出来、占满高度的侧边栏，例如窄屏的全站导航。打开时焦点限制在栏里，页面不能滚动；
 * 点外面、按 Esc、点右上角的关闭或者朝来的方向划回去都会关闭，焦点回到触发它的按钮（DESIGN.md §9）。
 * 需要用户做决定时改用 Dialog
 */
export function Sheet({ trigger, open, onOpenChange, side = 'end', title, closeLabel, children }: SheetProps) {
  const style = sides[side]
  return (
    <Drawer.Root
      open={open}
      onOpenChange={onOpenChange ? (next) => onOpenChange(next) : undefined}
      swipeDirection={style.swipe}
    >
      {trigger && <Drawer.Trigger render={trigger} />}
      <Drawer.Portal>
        <Drawer.Backdrop
          className={
            // 和 Dialog 一样蒙上一层底色：亮色下变浅、暗色下变暗
            'fixed inset-0 z-40 bg-[color-mix(in_srgb,var(--color-bg)_80%,transparent)] transition-opacity duration-base ease-step motion-reduce:transition-none data-ending-style:opacity-0 data-starting-style:opacity-0'
          }
        />
        <Drawer.Viewport className={cx('fixed inset-0 z-40 flex', style.viewport)}>
          <Drawer.Popup
            className={cx(
              // 渲染在 body 下，字体自己设。右边留出 48px 的蒙层，看得出还在原来的页面上、点那里就能关掉。
              // 进出场是四格阶跃地滑进滑出；手指拖动时跟着手指走，不带过渡
              'flex h-full w-80 max-w-[calc(100vw-(--spacing(12)))] flex-col border-border-strong bg-surface-raised font-sans text-text shadow-pixel-lg outline-none',
              'translate-x-(--drawer-swipe-movement-x) transition-[translate] duration-base ease-step data-swiping:transition-none motion-reduce:transition-none',
              style.popup,
            )}
          >
            {/* 顶栏和页头一样高，导航栏里的 Logo 和页头的 Logo 落在同一个位置 */}
            <div className="flex h-16 shrink-0 items-center justify-between gap-2 border-b border-border pr-2 pl-4">
              <Drawer.Title className="min-w-0 font-pixel text-pixel-1 text-text">{title}</Drawer.Title>
              <Drawer.Close
                render={
                  <IconButton label={closeLabel}>
                    <Close />
                  </IconButton>
                }
              />
            </div>
            <Drawer.Content className="min-h-0 flex-1 overflow-y-auto">{children}</Drawer.Content>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
