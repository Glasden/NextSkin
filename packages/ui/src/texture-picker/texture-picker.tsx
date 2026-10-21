'use client'

import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import { Check } from 'pixelarticons/react/Check.js'
import type { ReactNode } from 'react'
import { cx } from '../cx.ts'
import { focusRing } from '../styles.ts'

export interface TexturePickerOption<Value extends string> {
  value: Value
  /** 材质名，或衣柜里给这件起的名字。用户产生的内容，用正文字体（DESIGN.md §4） */
  name: string
  /** ×3 的 SkinFigure */
  figure: ReactNode
}

export interface TexturePickerProps<Value extends string> {
  options: readonly TexturePickerOption<Value>[]
  value?: Value | null
  defaultValue?: Value
  onValueChange?: (value: Value) => void
  /** 表单提交时的字段名 */
  name?: string
  disabled?: boolean
  /** 不放在 Field 里时必须提供，例如“选择皮肤” */
  'aria-label'?: string
}

// 悬停时抬起：向左上挪 2px，露出 2px 的硬边阴影（DESIGN.md §2）
const optionClass = cx(
  'group/raise relative flex min-w-0 flex-col overflow-hidden rounded-md border border-border bg-surface text-left',
  'transition-[translate,box-shadow] duration-fast ease-step motion-reduce:transition-none',
  'hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-pixel',
  // 选中：和 TextureCard 一样，向内再画一圈 2px 的描边，加左上角的勾选角标
  'data-checked:border-accent data-checked:outline-2 data-checked:-outline-offset-2 data-checked:outline-accent',
  'data-disabled:cursor-not-allowed data-disabled:hover:translate-0 data-disabled:hover:shadow-none',
  focusRing,
)

/**
 * 从一组材质里选一件，例如给角色换皮肤时从衣柜里挑。每一件是一张迷你卡片：×3 的展台加名字，
 * 选中的加粗强调色边框和勾选角标，不只靠颜色区分（DESIGN.md §2.1）。语义是单选按钮组，方向键切换。
 * 浏览材质、去详情页改用 TextureCard
 */
export function TexturePicker<Value extends string>({
  options,
  value,
  defaultValue,
  onValueChange,
  name,
  disabled,
  'aria-label': ariaLabel,
}: TexturePickerProps<Value>) {
  return (
    <RadioGroup<Value>
      aria-label={ariaLabel}
      // null 表示受控但还没选：Base UI 用 null 表示没有选中项，undefined 才是非受控
      value={value === undefined ? undefined : (value ?? (null as unknown as Value))}
      defaultValue={defaultValue}
      onValueChange={(next) => onValueChange?.(next)}
      name={name}
      disabled={disabled}
      className="grid grid-cols-3 gap-3 sm:grid-cols-4"
    >
      {options.map((option) => (
        <Radio.Root key={option.value} value={option.value} aria-label={option.name} className={optionClass}>
          <span className="relative grid h-28 place-items-center border-b border-border bg-stage">
            {option.figure}
            <Radio.Indicator className="absolute top-0 left-0 grid size-6 place-items-center rounded-br-sm bg-accent text-accent-fg">
              <Check aria-hidden />
            </Radio.Indicator>
          </span>
          <span className="truncate px-2 py-1.5 text-sm text-text">{option.name}</span>
        </Radio.Root>
      ))}
    </RadioGroup>
  )
}
