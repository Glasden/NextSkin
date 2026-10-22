'use client'

import { Copy } from 'pixelarticons/react/Copy.js'
import { useRef, type ComponentPropsWithoutRef } from 'react'
import { cx } from '../cx.ts'
import { IconButton } from '../icon-button/icon-button.tsx'
import { useToast } from '../toast/toast.tsx'

/** 代码块复制按钮的文案 */
export interface MarkdownCopyLabels {
  /** 按钮的名称，例如“复制” */
  label: string
  /** 复制成功的提示 */
  done: string
  /** 复制失败的提示，说明怎么手动复制 */
  failed: string
}

/**
 * 右上角带复制按钮的代码块，复制整块的文字。要放在 ToastProvider 里面：结果用 Toast 告诉用户。
 * 样子同 OAuth 应用的凭据那一行：按钮和第一行字居中对齐
 */
export function CopyableCodeBlock({
  copy,
  className,
  ...props
}: ComponentPropsWithoutRef<'pre'> & { copy: MarkdownCopyLabels }) {
  const ref = useRef<HTMLPreElement>(null)
  const toast = useToast()
  return (
    <div className="flex items-start gap-1 rounded-sm bg-surface-sunken py-1 pr-1">
      <pre {...props} ref={ref} className={cx('min-w-0 flex-1 overflow-x-auto py-1.5 pl-3', className)} />
      <IconButton
        label={copy.label}
        size="sm"
        onClick={() => {
          // 代码块的文字末尾总有一个换行（mdast-util-to-hast 加的），粘贴到聊天框里会多出一行
          const text = (ref.current?.textContent ?? '').replace(/\n$/, '')
          // 剪贴板接口只在 HTTPS（和 localhost）下可用，自己架设的站点常常是 HTTP。这时提示手动复制
          const copied = window.isSecureContext
            ? navigator.clipboard.writeText(text)
            : Promise.reject(new Error('insecure context'))
          void copied.then(
            () => toast.show({ tone: 'success', title: copy.done }),
            () => toast.show({ tone: 'danger', title: copy.failed }),
          )
        }}
      >
        <Copy />
      </IconButton>
    </div>
  )
}
