'use client'

import { mergeProps } from '@base-ui/react/merge-props'
import { useRender } from '@base-ui/react/use-render'
import type { ReactNode } from 'react'
import { cx } from '../cx.ts'
import { focusRing } from '../styles.ts'

export interface NavProps {
  /** 读屏软件用的名称，例如“用户中心” */
  label: string
  /** NavItem */
  children: ReactNode
}

/**
 * 用户中心和后台的分区导航。宽屏（lg 以上）是侧栏里的竖排列表；窄屏改成横排，放不下时横向滚动。
 * 页面里的分组切换用 Tabs
 */
export function Nav({ label, children }: NavProps) {
  return (
    <nav aria-label={label} className="min-w-0">
      <ul className="-mx-4 flex gap-1 overflow-x-auto px-4 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0">
        {children}
      </ul>
    </nav>
  )
}

export interface NavItemProps extends Omit<useRender.ComponentProps<'a'>, 'className' | 'style' | 'children'> {
  /** 24px 的 pixelarticons 图标 */
  icon: ReactNode
  children: ReactNode
  /** 当前页面：带 aria-current，底色用 accent-subtle，再加一条强调色的竖条（窄屏是底边），不只靠颜色区分 */
  current?: boolean
}

// 悬停是底色混入 12% 的 text（DESIGN.md §2）；当前项不变色
const itemClass = cx(
  'relative flex h-10 shrink-0 items-center gap-2 rounded-sm px-3 font-pixel text-pixel-1 whitespace-nowrap text-text select-none',
  'hover:bg-[color-mix(in_srgb,var(--color-bg)_88%,var(--color-text))]',
  'aria-[current=page]:bg-accent-subtle aria-[current=page]:text-accent',
  // 当前项的标记：窄屏是底边 4px，宽屏是左边 4px，都是不圆角的色块
  'aria-[current=page]:after:absolute aria-[current=page]:after:inset-x-3 aria-[current=page]:after:bottom-0 aria-[current=page]:after:h-1 aria-[current=page]:after:bg-accent',
  'lg:aria-[current=page]:after:inset-x-auto lg:aria-[current=page]:after:inset-y-2 lg:aria-[current=page]:after:left-0 lg:aria-[current=page]:after:h-auto lg:aria-[current=page]:after:w-1',
  focusRing,
  // 横排在窄屏上，点击区域扩到 44px（DESIGN.md §9）
  'pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:-inset-y-0.5',
)

/** 导航里的一项。站内跳转用 render 换成框架的链接组件，例如 `render={<NextLink href="/user" />}` */
export function NavItem({ icon, children, current = false, render, ...props }: NavItemProps) {
  const link = useRender({
    defaultTagName: 'a',
    render,
    props: mergeProps<'a'>(
      {
        className: itemClass,
        'aria-current': current ? 'page' : undefined,
        children: (
          <>
            <span aria-hidden className="shrink-0">
              {icon}
            </span>
            {children}
          </>
        ),
      },
      props,
    ),
  })
  return <li className="shrink-0">{link}</li>
}
