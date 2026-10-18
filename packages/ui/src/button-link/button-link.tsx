'use client'

import { mergeProps } from '@base-ui/react/merge-props'
import { useRender } from '@base-ui/react/use-render'
import { buttonLook } from '../button/button.tsx'

export interface ButtonLinkProps extends Omit<useRender.ComponentProps<'a'>, 'className' | 'style'> {
  /** primary 每个视图最多一个，和 Button 共用这个名额 */
  variant?: 'primary' | 'secondary'
  /** 高 40 / 48px：默认、前台的主要操作 */
  size?: 'md' | 'lg'
}

/**
 * 长得像按钮的跳转，例如首页的“注册”“上传材质”：引导去下一个页面的主要入口。
 * 普通的站内跳转用 Link，执行操作用 Button（DESIGN.md §6）。站内跳转用 render 换成框架的链接组件，
 * 例如 `<ButtonLink render={<NextLink href="/sign-up" />}>注册</ButtonLink>`
 */
export function ButtonLink({ variant = 'secondary', size = 'md', render, children, ...props }: ButtonLinkProps) {
  return useRender({
    defaultTagName: 'a',
    render,
    props: mergeProps<'a'>(
      {
        className: buttonLook(variant, size),
        children: <span className="inline-flex items-center gap-2">{children}</span>,
      },
      props,
    ),
  })
}
