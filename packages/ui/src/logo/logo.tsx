'use client'

import { useRender } from '@base-ui/react/use-render'
import { cx } from '../cx.ts'
import { focusRing } from '../styles.ts'

export interface LogoProps {
  /** 站点名，取自站点设置 */
  name: string
  /** 每格 6px（后台侧栏、页脚）或 8px（页头） */
  size?: 'sm' | 'md'
  /**
   * 页头的标志一般链接到首页：传框架的链接组件，例如 `render={<NextLink href="/" />}`。
   * 链接不加下划线，键盘聚焦时显示焦点框
   */
  render?: useRender.RenderProp
}

const sizes = {
  sm: { mark: 'w-6 h-3', name: 'text-pixel-1', gap: 'gap-2' },
  md: { mark: 'w-8 h-4', name: 'text-pixel-2', gap: 'gap-3' },
}

/**
 * 标志：皮肤材质里头部六个面的展开图，上一行是顶和底，下一行是右、前、左、后（DESIGN.md §2.2）。
 * 只有前脸用强调色
 */
export function Logo({ name, size = 'md', render }: LogoProps) {
  const style = sizes[size]
  return useRender({
    defaultTagName: 'span',
    render,
    props: {
      className: cx('inline-flex items-center', style.gap, render && cx('rounded-sm', focusRing)),
      children: (
        <>
          <span aria-hidden className={cx('grid shrink-0 grid-cols-4 grid-rows-2', style.mark)}>
            <span className="col-start-2 row-start-1 bg-text" />
            <span className="col-start-3 row-start-1 bg-text-muted" />
            <span className="col-start-1 row-start-2 bg-border-strong" />
            <span className="col-start-2 row-start-2 bg-accent" />
            <span className="col-start-3 row-start-2 bg-border-strong" />
            <span className="col-start-4 row-start-2 bg-text-muted" />
          </span>
          <span className={cx('font-pixel text-text', style.name)}>{name}</span>
        </>
      ),
    },
  })
}
