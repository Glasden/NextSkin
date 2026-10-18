'use client'

import { Input as BaseInput } from '@base-ui/react/input'
import { useState } from 'react'
import { cx } from '../cx.ts'
import { focusRing } from '../styles.ts'

export interface TextareaProps {
  name?: string
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  placeholder?: string
  required?: boolean
  disabled?: boolean
  /** 可见的行数，决定最小高度；用户可以纵向拖大 */
  rows?: number
  /**
   * 最多多少个字符。设了就在右下角显示“已输入 / 上限”，超出时浏览器不让再输入。
   * 按 UTF-16 计数，比服务端按码位计数更严，不会出现页面放行、服务端拒绝的情况
   */
  maxLength?: number
  /** 不放在 Field 里时必须提供 */
  'aria-label'?: string
}

/** 多行文本，例如材质描述、举报理由。放在 Field 里使用；单行文本用 Input。宽度占满父元素 */
export function Textarea({
  value,
  defaultValue,
  onValueChange,
  rows = 4,
  maxLength,
  'aria-label': ariaLabel,
  ...props
}: TextareaProps) {
  const [uncontrolled, setUncontrolled] = useState(defaultValue ?? '')
  const length = (value ?? uncontrolled).length
  return (
    <div className="relative flex flex-col">
      <BaseInput
        {...props}
        aria-label={ariaLabel}
        value={value}
        defaultValue={defaultValue}
        onValueChange={(next) => {
          if (value === undefined) setUncontrolled(next)
          onValueChange?.(next)
        }}
        render={<textarea rows={rows} maxLength={maxLength} />}
        // 禁用可能来自外层的 Field，所以按 Base UI 设的 data-disabled 取样式，不看 props
        className={cx(
          'w-full min-w-0 resize-y rounded-sm border border-border-strong bg-surface px-3 py-2 font-sans text-base text-text placeholder:text-text-muted',
          'data-invalid:border-danger',
          'data-disabled:cursor-not-allowed data-disabled:resize-none data-disabled:border-border data-disabled:bg-surface-sunken data-disabled:text-text-muted',
          focusRing,
          // 给右下角的计数留出一行
          maxLength !== undefined && 'pb-7',
        )}
      />
      {maxLength !== undefined && (
        <span
          aria-hidden
          className="pointer-events-none absolute right-3 bottom-2 font-pixel text-pixel-1 text-text-muted tabular-nums"
        >
          {`${length} / ${maxLength}`}
        </span>
      )}
    </div>
  )
}
