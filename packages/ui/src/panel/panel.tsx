import type { HTMLAttributes, ReactNode } from 'react'
import { cx } from '../cx.ts'

export interface PanelProps extends Omit<HTMLAttributes<HTMLElement>, 'className' | 'style'> {
  children?: ReactNode
  /** 渲染成哪个元素：列表用 ul、ol、li，带标题的一块用 section */
  as?: 'div' | 'section' | 'ul' | 'ol' | 'li'
  /**
   * surface：页面上的面板，主题让卡片静止带阴影时它也带（ADR-0058）。
   * inset：套在面板、对话框里的框，透出外面的底色，不带阴影；bg、sunken 同 inset，底色是 bg 或 surface-sunken
   */
  tone?: 'surface' | 'inset' | 'bg' | 'sunken'
  /** 内边距：none 给列表和自己排版的内容，sm 12px，md 16px，lg 24px，responsive 窄屏 16px、sm 以上 24px */
  padding?: 'none' | 'sm' | 'md' | 'lg' | 'responsive'
  /** 子元素竖着排，间距 4、12、16、20 或 24px（4px 网格，DESIGN.md §2）；不传时不排版 */
  gap?: 1 | 3 | 4 | 5 | 6
  /** 在父元素的 flex 布局里占满剩下的空间，例如和别的面板并排时一样高 */
  grow?: boolean
  /** 列表：子元素之间画分隔线 */
  divided?: boolean
  /** 裁掉超出圆角的内容，例如子元素自己带底色、贴着边 */
  clip?: boolean
}

const tones = {
  surface: 'border-border bg-surface shadow-(--card-shadow)',
  inset: 'border-border',
  bg: 'border-border bg-bg',
  sunken: 'border-border bg-surface-sunken',
}

const paddings = { none: '', sm: 'p-3', md: 'p-4', lg: 'p-6', responsive: 'p-4 sm:p-6' }
const gaps = { 1: 'gap-1', 3: 'gap-3', 4: 'gap-4', 5: 'gap-5', 6: 'gap-6' }

/**
 * 页面上的面板：圆角、常规边框、底色，主题的结构决定它静止时带不带阴影（ADR-0058）。页面里不手拼面板，
 * 否则主题换了结构时会漏掉。里面怎么排由内容自己定，Panel 只管竖排和间距这一种最常见的
 */
export function Panel({
  as: Element = 'div',
  tone = 'surface',
  padding = 'lg',
  gap,
  grow = false,
  divided = false,
  clip = false,
  ...props
}: PanelProps) {
  return (
    <Element
      {...props}
      className={cx(
        'rounded-md border',
        tones[tone],
        paddings[padding],
        gap !== undefined && cx('flex flex-col', gaps[gap]),
        grow && 'min-w-0 flex-1',
        divided && 'divide-y divide-border',
        clip && 'overflow-hidden',
      )}
    />
  )
}
