'use client'

import { mergeProps } from '@base-ui/react/merge-props'
import { useRender } from '@base-ui/react/use-render'
import { cx } from '../cx.ts'
import { focusRing } from '../styles.ts'

export interface LinkProps extends Omit<useRender.ComponentProps<'a'>, 'className' | 'style'> {
  /**
   * accent：强调色加下划线，正文里和单独出现的链接。
   * quiet：正文色，悬停时才有下划线，成组出现的一列链接（页脚）；满屏强调色会抢走材质的注意力（DESIGN.md §2.1）
   */
  tone?: 'accent' | 'quiet'
}

const tones = {
  accent: 'text-accent underline decoration-1 underline-offset-4 hover:decoration-2',
  quiet: 'text-text decoration-1 underline-offset-4 hover:underline',
}

/**
 * 跳转到其他页面。默认渲染 `<a>`；站内跳转用 render 换成框架的链接组件，
 * 例如 `<Link render={<NextLink href="/auth/forgot" />}>忘记密码</Link>`。执行操作用 Button
 */
export function Link({ tone = 'accent', render, ...props }: LinkProps) {
  return useRender({
    defaultTagName: 'a',
    render,
    props: mergeProps<'a'>({ className: cx('rounded-sm', tones[tone], focusRing) }, props),
  })
}
