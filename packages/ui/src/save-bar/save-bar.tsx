'use client'

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cx } from '../cx.ts'

export interface SaveBarProps {
  /** 有没有没保存的改动：有的时候吸在视口底部，长表单不用翻到末尾才能保存 */
  dirty: boolean
  /** 左边的一句状态，例如“3 项改动还没保存” */
  status?: ReactNode
  /** 没保存成功的原因：替换状态显示成红字，并立即读出 */
  error?: ReactNode
  /** 右边的按钮，通常只有提交按钮 */
  children: ReactNode
}

/**
 * 面板底部的保存栏，当带边框的面板的最后一个子元素，例如后台设置。有改动时吸在视口底部，面板的末尾滚进视野后回到原处；
 * 浮在内容上面时上沿换成深色的线，和面板里各行之间的分隔线分开。
 * 吸住的时候给页面留出同样高的滚动内边距，焦点落到被栏盖住的项上时，把它滚到栏的上方（WCAG 2.4.11）
 */
export function SaveBar({ dirty, status, error, children }: SaveBarProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [floating, setFloating] = useState(false)

  // 视口的底边往里收 1px：吸住的栏占着视口的最后一行像素，露在视口里、底边超出收窄的底边；回到原处时完整可见。
  // 按栏所在文档自己的视口算，页面在 iframe 里（Storybook）时收窄的才是 iframe 的底边。
  // 阈值要有 0 和 1：只有 1 时，Chromium 不到完整可见就不算相交，露出一部分时不回调
  useEffect(() => {
    const bar = ref.current
    if (!bar) return
    const observer = new IntersectionObserver(
      ([entry]) =>
        setFloating(
          !!entry?.rootBounds &&
            entry.intersectionRatio > 0 &&
            entry.boundingClientRect.bottom > entry.rootBounds.bottom,
        ),
      { root: bar.ownerDocument, rootMargin: '0px 0px -1px 0px', threshold: [0, 1] },
    )
    observer.observe(bar)
    return () => observer.disconnect()
  }, [])

  // 在绘制之前处理：栏刚吸住时，可能正好盖住刚改的那一项（滚到视口底边的输入框、勾选框）
  useLayoutEffect(() => {
    const bar = ref.current
    const panel = bar?.parentElement
    if (!dirty || !bar || !panel) return
    const root = document.documentElement
    // 多留 16px，焦点框（2px 加 2px 间距）不贴着栏
    const reserve = () => {
      root.style.scrollPaddingBottom = `${bar.offsetHeight + 16}px`
    }
    // 面板里被栏盖住一部分的项挪到栏的上方，滚动内边距保证留出栏的高度。
    // 浏览器自己只管完全看不见的：文本域只保证光标那一行露出来，点击露出来的那一半也不滚
    const reveal = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement) || bar.contains(target) || !panel.contains(target)) return
      const field = target.getBoundingClientRect()
      const own = bar.getBoundingClientRect()
      if (field.bottom > own.top && field.top < own.bottom) target.scrollIntoView({ block: 'nearest' })
    }
    const onFocus = (event: FocusEvent) => reveal(event.target)
    reserve()
    reveal(document.activeElement)
    panel.addEventListener('focusin', onFocus)
    // 窄屏上错误信息换行时栏会变高
    const resize = new ResizeObserver(reserve)
    resize.observe(bar)
    return () => {
      resize.disconnect()
      panel.removeEventListener('focusin', onFocus)
      root.style.scrollPaddingBottom = ''
    }
  }, [dirty])

  return (
    <div
      ref={ref}
      data-dirty={dirty || undefined}
      data-floating={(dirty && floating) || undefined}
      className={cx(
        'flex items-center justify-end gap-4 rounded-b-md border-t border-border bg-surface-sunken px-4 py-3 sm:px-6',
        'data-dirty:sticky data-dirty:bottom-0 data-dirty:z-20',
        // 浮着的时候下面还有内容，圆角会露出底下的一角
        'data-floating:rounded-b-none data-floating:border-t-border-strong',
      )}
    >
      {error ? (
        <p role="alert" className="min-w-0 flex-1 text-sm text-pretty text-danger">
          {error}
        </p>
      ) : (
        status && <p className="min-w-0 flex-1 text-sm text-pretty text-text-muted">{status}</p>
      )}
      <div className="flex shrink-0 gap-2">{children}</div>
    </div>
  )
}
