'use client'

import { mergeProps } from '@base-ui/react/merge-props'
import { useRender } from '@base-ui/react/use-render'
import type { ReactNode } from 'react'
import { cx } from '../cx.ts'
import { focusRing } from '../styles.ts'

export interface NavProps {
  /** 读屏软件用的名称，例如“用户中心” */
  label: string
  /**
   * sidebar：用户中心和后台的侧栏，宽屏竖排并吸在页头下面、窄屏横排；
   * header：页头里的全站导航，始终横排
   */
  placement?: 'sidebar' | 'header'
  /** NavItem */
  children: ReactNode
}

/**
 * 分区导航。侧栏在宽屏（lg 以上）是竖排列表，长页面滚动时留在视野里；窄屏改成横排，放不下时横向滚动；页头里的始终横排。
 * 页面里的分组切换用 Tabs
 */
export function Nav({ label, placement = 'sidebar', children }: NavProps) {
  return (
    <nav
      aria-label={label}
      // 宽屏侧栏吸在页头（64px 加 1px 底边）下面，和布局给侧栏留的 32px 上边距对齐，开始滚动时几乎不动。
      // flow-root 挡住列表的负外边距，不让它穿出去缩小 nav 的外边距盒，否则 sticky 会把 nav 往下推
      className={cx('min-w-0', placement === 'sidebar' && 'lg:sticky lg:top-24 lg:flow-root')}
    >
      <ul
        data-placement={placement}
        className={cx(
          'group/nav flex gap-1',
          // 宽屏比视口高时列表自己滚动，底下同样留 32px。滚动容器会裁掉焦点框，p-1 给它留出位置，-m-1 抵消这圈内边距
          placement === 'sidebar' &&
            '-mx-4 overflow-x-auto px-4 lg:-m-1 lg:max-h-[calc(100dvh-(--spacing(31)))] lg:flex-col lg:overflow-y-auto lg:p-1',
        )}
      >
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
  // 页头里的导航宽屏也是横排，标记留在底边
  'group-data-[placement=header]/nav:lg:aria-[current=page]:after:inset-x-3 group-data-[placement=header]/nav:lg:aria-[current=page]:after:inset-y-auto group-data-[placement=header]/nav:lg:aria-[current=page]:after:bottom-0 group-data-[placement=header]/nav:lg:aria-[current=page]:after:h-1 group-data-[placement=header]/nav:lg:aria-[current=page]:after:w-auto',
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
