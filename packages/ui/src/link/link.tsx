'use client'

import { mergeProps } from '@base-ui/react/merge-props'
import { useRender } from '@base-ui/react/use-render'
import { cx } from '../cx.ts'
import { focusRing } from '../styles.ts'

export type LinkProps = Omit<useRender.ComponentProps<'a'>, 'className' | 'style'>

const linkClass = cx('rounded-sm text-accent underline decoration-1 underline-offset-4 hover:decoration-2', focusRing)

/**
 * 跳转到其他页面。默认渲染 `<a>`；站内跳转用 render 换成框架的链接组件，
 * 例如 `<Link render={<NextLink href="/auth/forgot" />}>忘记密码</Link>`。执行操作用 Button
 */
export function Link({ render, ...props }: LinkProps) {
  return useRender({ defaultTagName: 'a', render, props: mergeProps<'a'>({ className: linkClass }, props) })
}
