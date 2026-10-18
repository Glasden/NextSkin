'use client'

import { Select as BaseSelect } from '@base-ui/react/select'
import { Check } from 'pixelarticons/react/Check.js'
import { ChevronDown } from 'pixelarticons/react/ChevronDown.js'
import { cx } from '../cx.ts'
import { focusRing } from '../styles.ts'

export interface SelectOption<Value extends string> {
  value: Value
  /** 选项的文字，选中后也显示在触发按钮上 */
  label: string
}

export interface SelectProps<Value extends string> {
  options: readonly SelectOption<Value>[]
  value?: Value
  defaultValue?: Value
  onValueChange?: (value: Value) => void
  /** 表单提交时的字段名 */
  name?: string
  disabled?: boolean
  required?: boolean
  /** 高 32 / 40 / 48px，和同一行的 Input、Button 取相同的尺寸 */
  size?: 'sm' | 'md' | 'lg'
  /** 不放在 Field 里时必须提供，读屏软件靠它读出这个选择框是做什么的 */
  'aria-label'?: string
}

const triggerSizes = {
  sm: 'h-8 pr-1 pl-2 text-sm',
  md: 'h-10 pr-2 pl-3 text-base',
  lg: 'h-12 pr-3 pl-4 text-base',
}
const itemSizes = { sm: 'h-8 text-sm', md: 'h-10 text-base', lg: 'h-10 text-base' }

// 悬停和展开时底色混入 12% 的 text（DESIGN.md §2）
const triggerClass = cx(
  'flex w-full min-w-0 items-center justify-between gap-2 rounded-sm border border-border-strong font-sans text-text select-none',
  '[--select-bg:var(--color-surface)] bg-(--select-bg)',
  'hover:bg-[color-mix(in_srgb,var(--select-bg)_88%,var(--color-text))]',
  'data-popup-open:bg-[color-mix(in_srgb,var(--select-bg)_88%,var(--color-text))]',
  'data-invalid:border-danger',
  // 禁用可能来自外层的 Field，按 Base UI 设的 data-disabled 取样式
  'data-disabled:cursor-not-allowed data-disabled:border-border data-disabled:[--select-bg:var(--color-surface-sunken)] data-disabled:text-text-muted data-disabled:hover:bg-(--select-bg)',
  focusRing,
)

const itemClass = cx(
  'grid cursor-default grid-cols-[24px_1fr] items-center gap-2 pr-4 pl-2 text-text outline-none select-none',
  'data-highlighted:bg-[color-mix(in_srgb,var(--color-surface-raised)_88%,var(--color-text))]',
  'data-selected:font-medium',
)

/**
 * 从几个固定的选项里选一个，例如界面语言。选项多到需要搜索时改用 Combobox，三到五个互斥选项的即时切换用
 * SegmentedControl（DESIGN.md §6）。放在 Field 里时，Field 要设 `nativeLabel={false}`：触发器是按钮，原生 label
 * 会把点击转给它。宽度占满父元素
 */
export function Select<Value extends string>({
  options,
  value,
  defaultValue,
  onValueChange,
  name,
  disabled,
  required,
  size = 'md',
  'aria-label': ariaLabel,
}: SelectProps<Value>) {
  return (
    <BaseSelect.Root<Value>
      items={options}
      value={value}
      defaultValue={defaultValue}
      onValueChange={(next) => {
        if (next !== null) onValueChange?.(next)
      }}
      name={name}
      disabled={disabled}
      required={required}
    >
      <BaseSelect.Trigger aria-label={ariaLabel} className={cx(triggerClass, triggerSizes[size])}>
        <BaseSelect.Value className="truncate" />
        <BaseSelect.Icon className="flex shrink-0 text-text-muted">
          <ChevronDown aria-hidden />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        {/* 弹出层放在触发器下方，不像系统下拉框那样盖住触发器：与 Menu 的位置一致 */}
        <BaseSelect.Positioner
          className="z-10 outline-none"
          alignItemWithTrigger={false}
          sideOffset={4}
          collisionPadding={16}
        >
          <BaseSelect.Popup
            className={cx(
              // 渲染在 body 下，字体自己设。弹出是四格阶跃的淡入
              'min-w-(--anchor-width) rounded-md border border-border-strong bg-surface-raised font-sans text-text shadow-pixel-lg outline-none',
              'transition-opacity duration-fast ease-step motion-reduce:transition-none data-ending-style:opacity-0 data-starting-style:opacity-0',
            )}
          >
            <BaseSelect.List className="max-h-(--available-height) overflow-y-auto py-1">
              {options.map((option) => (
                <BaseSelect.Item key={option.value} value={option.value} className={cx(itemClass, itemSizes[size])}>
                  {/* 选中项打勾，不只靠字重区分（DESIGN.md §2.1） */}
                  <BaseSelect.ItemIndicator className="col-start-1 flex text-accent">
                    <Check aria-hidden />
                  </BaseSelect.ItemIndicator>
                  <BaseSelect.ItemText className="col-start-2 truncate">{option.label}</BaseSelect.ItemText>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  )
}
