'use client'

import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import { useState } from 'react'
import { cx } from '../cx.ts'
import { focusRing } from '../styles.ts'

export interface SegmentedControlOption<Value extends string> {
  value: Value
  label: string
}

export interface SegmentedControlProps<Value extends string> {
  /** 三到五个互斥的选项；更多时改用 Tabs 或 Select（DESIGN.md §6） */
  options: readonly SegmentedControlOption<Value>[]
  value?: Value
  defaultValue?: Value
  onValueChange?: (value: Value) => void
  /** 表单提交时的字段名 */
  name?: string
  disabled?: boolean
  /** 高 32 / 40px，和同一行的 Input、Button 取相同的尺寸 */
  size?: 'sm' | 'md'
  /** 占满父元素的宽度，例如移动端的表单 */
  fullWidth?: boolean
  /** 不放在 Field 里时必须提供，例如“材质类型” */
  'aria-label'?: string
}

const segmentSizes = { sm: 'h-6 px-2 text-sm', md: 'h-8 px-3 text-base' }

/**
 * 三到五个互斥选项的即时切换，例如材质类型、排序方式。每段等宽；选中的那段是一块抬起的底色，
 * 切换时一格一格地挪过去（DESIGN.md §2），减少动态效果时直接跳过去。语义是单选按钮组，方向键切换
 */
export function SegmentedControl<Value extends string>({
  options,
  value,
  defaultValue,
  onValueChange,
  name,
  disabled,
  size = 'md',
  fullWidth = false,
  'aria-label': ariaLabel,
}: SegmentedControlProps<Value>) {
  const [uncontrolled, setUncontrolled] = useState(defaultValue)
  const current = value ?? uncontrolled
  const index = options.findIndex((option) => option.value === current)
  return (
    <RadioGroup<Value>
      aria-label={ariaLabel}
      value={value}
      defaultValue={defaultValue}
      onValueChange={(next) => {
        if (value === undefined) setUncontrolled(next)
        onValueChange?.(next)
      }}
      name={name}
      disabled={disabled}
      className={cx(
        'relative grid auto-cols-fr grid-flow-col rounded-sm border border-border bg-surface-sunken p-0.75 select-none',
        fullWidth ? 'w-full' : 'w-fit',
        'data-disabled:cursor-not-allowed',
      )}
    >
      {index >= 0 && (
        // 选中块：宽度是一段，按序号整段平移
        <span
          aria-hidden
          className={cx(
            'absolute inset-y-0.75 left-0.75 rounded-sm border border-border-strong bg-surface shadow-pixel',
            'transition-transform duration-slow ease-step motion-reduce:transition-none',
            disabled && 'border-border shadow-none',
          )}
          style={{
            width: `calc((100% - 6px) / ${options.length})`,
            transform: `translateX(${index * 100}%)`,
          }}
        />
      )}
      {options.map((option) => (
        <Radio.Root
          key={option.value}
          value={option.value}
          // 放在 Field 里时 Base UI 会拿字段的标签给每个选项命名；选项要用自己的文字
          aria-label={option.label}
          className={cx(
            'relative grid place-items-center rounded-sm font-sans whitespace-nowrap text-text-muted',
            // 悬停是底色混入 12% 的 text（DESIGN.md §2）；选中的那段底下是选中块，不再变色
            'hover:text-text data-unchecked:hover:bg-[color-mix(in_srgb,var(--color-surface-sunken)_88%,var(--color-text))]',
            'data-checked:font-medium data-checked:text-text',
            'data-disabled:cursor-not-allowed data-disabled:text-border-strong data-disabled:hover:bg-transparent data-disabled:hover:text-border-strong',
            focusRing,
            segmentSizes[size],
          )}
        >
          {option.label}
        </Radio.Root>
      ))}
    </RadioGroup>
  )
}
