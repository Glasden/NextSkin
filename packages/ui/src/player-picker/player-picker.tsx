'use client'

import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import { Check } from 'pixelarticons/react/Check.js'
import { useId, type ReactNode } from 'react'
import { cx } from '../cx.ts'
import { focusRing } from '../styles.ts'

export interface PlayerPickerOption<Value extends string> {
  value: Value
  /** 角色名。用户产生的内容，用正文字体（DESIGN.md §4） */
  name: string
  /** 32px 的 PlayerHead；旁边写了名字，alt 传空字符串 */
  head: ReactNode
  /** 名字下面的一行补充，例如“正在用的皮肤：上学穿” */
  description?: ReactNode
}

export interface PlayerPickerProps<Value extends string> {
  options: readonly PlayerPickerOption<Value>[]
  value?: Value | null
  defaultValue?: Value
  onValueChange?: (value: Value) => void
  /** 表单提交时的字段名 */
  name?: string
  disabled?: boolean
  /** 不放在 Field 里时必须提供，例如“选择角色” */
  'aria-label'?: string
}

// 悬停时抬起，和 TexturePicker 相同：向左上挪 2px，露出 2px 的硬边阴影（DESIGN.md §2）
const optionClass = cx(
  'group/radio flex min-w-0 items-center gap-3 rounded-md border border-border bg-surface px-3 py-2.5 text-left',
  'transition-[translate,box-shadow] duration-fast ease-step motion-reduce:transition-none',
  'hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-pixel',
  // 选中：向内再画一圈 2px 的描边，前面的方框填强调色、打勾，不只靠颜色区分（DESIGN.md §2.1）
  'data-checked:border-accent data-checked:outline-2 data-checked:-outline-offset-2 data-checked:outline-accent',
  'data-disabled:cursor-not-allowed data-disabled:hover:translate-0 data-disabled:hover:shadow-none',
  focusRing,
)

// 方框和 Checkbox 同样大小、同样的悬停底色；勾是 24px 网格的图标，和方框的外沿对齐
const indicatorClass = cx(
  'relative size-6 shrink-0 rounded-sm border-2 border-border-strong text-accent-fg',
  '[--radio-bg:var(--color-surface)] bg-(--radio-bg)',
  'group-hover/radio:bg-[color-mix(in_srgb,var(--radio-bg)_88%,var(--color-text))]',
  'group-data-checked/radio:border-accent group-data-checked/radio:[--radio-bg:var(--color-accent)]',
  'group-data-disabled/radio:border-border group-data-disabled/radio:[--radio-bg:var(--color-surface-sunken)]',
)

/**
 * 从自己的角色里选一个，例如启动器授权时选择用哪个角色进服（ADR-0037）。竖排，每一行是方框、头像、
 * 角色名和一行补充；选中的加粗强调色边框并打勾。语义是单选按钮组，方向键切换。
 * 要看角色穿着什么，在旁边放展台；管理角色改用 PlayerCard
 */
export function PlayerPicker<Value extends string>({
  options,
  value,
  defaultValue,
  onValueChange,
  name,
  disabled,
  'aria-label': ariaLabel,
}: PlayerPickerProps<Value>) {
  const id = useId()
  return (
    <RadioGroup<Value>
      aria-label={ariaLabel}
      // null 表示受控但还没选：Base UI 用 null 表示没有选中项，undefined 才是非受控
      value={value === undefined ? undefined : (value ?? (null as unknown as Value))}
      defaultValue={defaultValue}
      onValueChange={(next) => onValueChange?.(next)}
      name={name}
      disabled={disabled}
      className="flex flex-col gap-2"
    >
      {options.map((option, index) => {
        const descriptionId = option.description === undefined ? undefined : `${id}-${index}`
        return (
          <Radio.Root
            key={option.value}
            value={option.value}
            aria-label={option.name}
            aria-describedby={descriptionId}
            className={optionClass}
          >
            <span className={indicatorClass}>
              <Radio.Indicator className="absolute -inset-0.5">
                <Check aria-hidden />
              </Radio.Indicator>
            </span>
            {option.head}
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-base text-text">{option.name}</span>
              {descriptionId && (
                <span id={descriptionId} className="truncate text-sm text-text-muted">
                  {option.description}
                </span>
              )}
            </span>
          </Radio.Root>
        )
      })}
    </RadioGroup>
  )
}
