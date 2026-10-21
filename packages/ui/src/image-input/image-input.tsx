'use client'

import { useId, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { Badge } from '../badge/badge.tsx'
import { Button } from '../button/button.tsx'
import { cx } from '../cx.ts'
import { checker } from '../styles.ts'

export interface ImageInputProps {
  /** 标签，例如“站点标志” */
  label: ReactNode
  /** 跟在标签后面的短状态，例如“默认图形”“已上传” */
  status?: string
  /** 当前的图片地址；null 表示没有上传，预览里画 fallback */
  src: string | null
  /** 没有上传时预览里画的东西，按每个预览尺寸调用一次，例如内置的像素图形 */
  fallback?: (size: number) => ReactNode
  /** 预览的尺寸（像素），从大到小，例如页头 32px、页脚 24px；每个尺寸一格棋盘格 */
  sizes?: readonly number[]
  /** 预览整体的名称，例如“站点标志的预览” */
  previewLabel: string
  /** 选中或拖进来一个文件时调用；文件的格式和尺寸由调用方检查 */
  onFile: (file: File) => void
  /** 例如 `image/png`，只是提示浏览器的文件选择框 */
  accept?: string
  uploadLabel: string
  /** 上传中：上传按钮显示加载动画 */
  uploading?: boolean
  /** 恢复默认的按钮；不传 onReset 时不显示 */
  resetLabel?: string
  onReset?: () => void
  /** 格式要求，放在按钮下方，例如“PNG，正方形，边长 16–512 像素” */
  description?: ReactNode
  error?: ReactNode
  disabled?: boolean
}

/**
 * 上传一张图片并预览，例如站点标志和图标（ADR-0042）：按几个实际用到的尺寸画在棋盘格上，透明的部分看得出来。
 * 图片可以拖到预览上，也可以点按钮选择；换图和恢复默认都要等表单保存才生效，由调用方决定
 */
export function ImageInput({
  label,
  status,
  src,
  fallback,
  sizes = [64],
  previewLabel,
  onFile,
  accept,
  uploadLabel,
  uploading = false,
  resetLabel,
  onReset,
  description,
  error,
  disabled = false,
}: ImageInputProps) {
  const input = useRef<HTMLInputElement>(null)
  const labelId = useId()
  const descriptionId = useId()
  const errorId = useId()
  // 同 FileDrop：dragenter / dragleave 在子元素之间移动时也会触发，按进出次数判断还在不在区域里
  const depth = useRef(0)
  const [over, setOver] = useState(false)
  const handlers =
    disabled || uploading
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
  const describedBy = [description && descriptionId, error && errorId].filter(Boolean).join(' ') || undefined
  return (
    <div role="group" aria-labelledby={labelId} className="flex flex-col gap-3">
      <div className="inline-flex flex-wrap items-center gap-2">
        <span id={labelId} className={cx('text-sm font-medium', disabled ? 'text-text-muted' : 'text-text')}>
          {label}
        </span>
        {status && <Badge>{status}</Badge>}
      </div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
        <div
          {...handlers}
          role="img"
          aria-label={previewLabel}
          data-over={over || undefined}
          data-invalid={error ? true : undefined}
          className={cx(
            'flex w-fit items-end gap-3 rounded-md border-2 border-dashed border-border-strong bg-surface p-3',
            'transition-colors duration-fast ease-step motion-reduce:transition-none',
            'data-invalid:border-danger data-over:border-accent data-over:bg-accent-subtle',
          )}
        >
          {sizes.map((size) => (
            <div key={size} className="flex flex-col items-center gap-1">
              <div className={cx('flex items-center justify-center rounded-sm border border-border p-2', checker)}>
                {src ? (
                  // 不经过 next/image（不变量 8）；预览整体有名字，单张图不用读出来
                  <img src={src} alt="" width={size} height={size} className="block" />
                ) : (
                  <span className="block" style={{ width: size, height: size }}>
                    {fallback?.(size)}
                  </span>
                )}
              </div>
              <span aria-hidden className="font-pixel text-pixel-1 text-text-muted">
                {size}
              </span>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            loading={uploading}
            disabled={disabled}
            aria-describedby={describedBy}
            onClick={() => input.current?.click()}
          >
            {uploadLabel}
          </Button>
          {onReset && resetLabel && (
            <Button size="sm" disabled={disabled || uploading} onClick={onReset}>
              {resetLabel}
            </Button>
          )}
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
      </div>
      {description && (
        <p id={descriptionId} className="text-sm text-pretty text-text-muted">
          {description}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
