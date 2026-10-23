'use client'

import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import { Check } from 'pixelarticons/react/Check.js'
import { useId, type ReactNode } from 'react'
import { cx } from '../cx.ts'
import { focusRing } from '../styles.ts'
import { boxClass, ThemePreviews } from '../theme-card/theme-card.tsx'

export interface ThemePickerOption<Value extends string> {
  value: Value
  /** 小样画哪套主题；“跟随站点默认”传站点默认的那套 */
  theme: string
  name: string
  /** 名字下面一行，例如“现在是钻石青” */
  description?: ReactNode
}

export interface ThemePickerProps<Value extends string> {
  options: readonly ThemePickerOption<Value>[]
  value?: Value | null
  defaultValue?: Value
  onValueChange?: (value: Value) => void
  name?: string
  disabled?: boolean
  /** 不放在 Field 里时必须提供，例如“主题” */
  'aria-label'?: string
}

// 悬停时抬起：向左上挪 2px，露出 4px 的硬边阴影，同 TextureCard
const optionClass = cx(
  'group/radio relative flex min-w-0 flex-col overflow-hidden rounded-md border border-border bg-surface text-left',
  'transition-[translate,box-shadow] duration-fast ease-step motion-reduce:transition-none',
  'hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-pixel-lg',
  'data-checked:border-accent data-checked:outline-2 data-checked:-outline-offset-2 data-checked:outline-accent',
  'data-disabled:cursor-not-allowed data-disabled:hover:translate-0 data-disabled:hover:shadow-none',
  focusRing,
)

// 未选中的方框和 Checkbox 同样的悬停底色
const indicatorClass = cx(
  boxClass,
  'border-border-strong [--radio-bg:var(--color-surface)] bg-(--radio-bg) text-accent-fg',
  'group-hover/radio:bg-[color-mix(in_srgb,var(--radio-bg)_88%,var(--color-text))]',
  'group-data-checked/radio:border-accent group-data-checked/radio:[--radio-bg:var(--color-accent)]',
  'group-data-disabled/radio:border-border group-data-disabled/radio:[--radio-bg:var(--color-surface-sunken)]',
)

/**
 * 用户中心挑一套主题：每套一张带亮暗两份小样的卡片，选中的加粗强调色边框、名字前面的方框打勾。
 * 语义是单选按钮组，方向键切换；点一下就该生效，页面不另放保存按钮
 */
export function ThemePicker<Value extends string>({
  options,
  value,
  defaultValue,
  onValueChange,
  name,
  disabled,
  'aria-label': ariaLabel,
}: ThemePickerProps<Value>) {
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
      className="grid gap-4 sm:grid-cols-2"
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
            <ThemePreviews theme={option.theme} />
            <span className="flex min-w-0 items-start gap-3 px-3 py-2">
              <span className={cx(indicatorClass, 'mt-0.5')}>
                <Radio.Indicator className="absolute -inset-0.5">
                  <Check aria-hidden />
                </Radio.Indicator>
              </span>
              <span className="flex min-w-0 flex-col gap-1">
                <span className="truncate text-base font-medium text-text">{option.name}</span>
                {descriptionId && (
                  <span id={descriptionId} className="truncate text-sm text-text-muted">
                    {option.description}
                  </span>
                )}
              </span>
            </span>
          </Radio.Root>
        )
      })}
    </RadioGroup>
  )
}
