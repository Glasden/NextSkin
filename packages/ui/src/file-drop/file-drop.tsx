'use client'

import { Upload } from 'pixelarticons/react/Upload.js'
import { useId, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { Button } from '../button/button.tsx'
import { cx } from '../cx.ts'

export interface FileDropProps {
  /** 选中或拖进来一个文件时调用；拖进来多个时只取第一个 */
  onFile: (file: File) => void
  /** 例如 `image/png`。只是提示浏览器的文件选择框，拖进来的文件仍要由调用方检查 */
  accept?: string
  /** 区域里的主要文字，例如“把 PNG 文件拖到这里” */
  title: ReactNode
  /** 补充说明，例如“PNG，最大 1024 KB” */
  description?: ReactNode
  /** 按钮的文字，例如“选择文件”；没有鼠标拖放的设备（手机、键盘用户）靠它选文件 */
  buttonLabel: string
  disabled?: boolean
  /** 错误信息，显示在区域下方，例如“这个文件不是 PNG” */
  error?: ReactNode
}

/**
 * 选择一个本地文件：可以拖进来，也可以点按钮打开系统的文件选择框。拖着文件经过时边框和底色变成强调色。
 * 宽度占满父元素
 */
export function FileDrop({ onFile, accept, title, description, buttonLabel, disabled, error }: FileDropProps) {
  const input = useRef<HTMLInputElement>(null)
  const errorId = useId()
  // dragenter / dragleave 在子元素之间移动时也会触发，按进出次数判断还在不在区域里
  const depth = useRef(0)
  const [over, setOver] = useState(false)
  const handlers = disabled
    ? {}
    : {
        onDragEnter: (event: DragEvent) => {
          event.preventDefault()
          depth.current++
          setOver(true)
        },
        onDragOver: (event: DragEvent) => event.preventDefault(),
        onDragLeave: () => {
          depth.current = Math.max(0, depth.current - 1)
          if (!depth.current) setOver(false)
        },
        onDrop: (event: DragEvent) => {
          event.preventDefault()
          depth.current = 0
          setOver(false)
          const file = event.dataTransfer.files[0]
          if (file) onFile(file)
        },
      }
  return (
    <div className="flex flex-col gap-2">
      <div
        {...handlers}
        data-over={over || undefined}
        data-invalid={error ? true : undefined}
        className={cx(
          'flex flex-col items-center gap-4 rounded-md border-2 border-dashed border-border-strong bg-surface px-6 py-10 text-center',
          'transition-colors duration-fast ease-step motion-reduce:transition-none',
          'data-invalid:border-danger',
          'data-over:border-accent data-over:bg-accent-subtle',
          disabled && 'cursor-not-allowed border-border bg-surface-sunken',
        )}
      >
        <span aria-hidden className={cx('[&>svg]:size-12', over ? 'text-accent' : 'text-text-muted')}>
          <Upload />
        </span>
        <div className="flex max-w-sm flex-col gap-1">
          <p className={cx('text-lg font-medium', disabled ? 'text-text-muted' : 'text-text')}>{title}</p>
          {description && <p className="text-sm text-pretty text-text-muted">{description}</p>}
        </div>
        <Button
          disabled={disabled}
          aria-describedby={error ? errorId : undefined}
          onClick={() => input.current?.click()}
        >
          {buttonLabel}
        </Button>
        <input
          ref={input}
          type="file"
          accept={accept}
          hidden
          disabled={disabled}
          onChange={(event) => {
            const file = event.target.files?.[0]
            // 清空，同一个文件改过以后再选一次也能触发
            event.target.value = ''
            if (file) onFile(file)
          }}
        />
      </div>
      {error && (
        <p id={errorId} className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
