'use client'

import { Checkbox as BaseCheckbox } from '@base-ui/react/checkbox'
import { Check } from 'pixelarticons/react/Check.js'
import { Minus } from 'pixelarticons/react/Minus.js'
import type { ReactNode } from 'react'
import { cx } from '../cx.ts'
import { focusRing } from '../styles.ts'

export interface CheckboxProps extends Omit<
  BaseCheckbox.Root.Props,
  'className' | 'style' | 'render' | 'nativeButton' | 'children'
> {
  /** 标签文字，点击它也会切换 */
  children: ReactNode
}

/**
 * 复选框。需要点“保存”才生效的选项用它，立即生效的开关用 Switch（DESIGN.md §6）。
 * 方框 24px，勾和横线是 pixelarticons 的 24px 图标；选中时填强调色，不只靠颜色区分（DESIGN.md §2.1）
 */
export function Checkbox({ children, disabled, ...props }: CheckboxProps) {
  return (
    <label
      className={cx(
        'group inline-flex items-start gap-2 text-base',
        disabled ? 'cursor-not-allowed text-text-muted' : 'cursor-pointer text-text',
      )}
    >
      <BaseCheckbox.Root
        {...props}
        disabled={disabled}
        className={cx(
          'relative inline-flex size-6 shrink-0 rounded-sm border-2',
          focusRing,
          disabled
            ? 'border-border bg-surface-sunken text-text-muted'
            : cx(
                // 悬停时底色混入 12% 的 text，和 Button 一致（DESIGN.md §2）
                '[--checkbox-bg:var(--color-surface)] border-border-strong text-accent-fg',
                'data-checked:[--checkbox-bg:var(--color-accent)] data-checked:border-accent',
                'data-indeterminate:[--checkbox-bg:var(--color-accent)] data-indeterminate:border-accent',
                'data-invalid:border-danger',
                'bg-(--checkbox-bg) group-hover:bg-[color-mix(in_srgb,var(--checkbox-bg)_88%,var(--color-text))]',
              ),
        )}
      >
        <BaseCheckbox.Indicator
          // 图标按 24px 网格画，和方框的外沿对齐
          render={(indicatorProps, state) => (
            <span {...indicatorProps} className="absolute -inset-0.5">
              {state.indeterminate ? <Minus aria-hidden /> : <Check aria-hidden />}
            </span>
          )}
        />
      </BaseCheckbox.Root>
      <span>{children}</span>
    </label>
  )
}
