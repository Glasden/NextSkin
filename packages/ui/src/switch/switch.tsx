'use client'

import { Switch as BaseSwitch } from '@base-ui/react/switch'
import type { ReactNode } from 'react'
import { cx } from '../cx.ts'
import { focusRing } from '../styles.ts'

export interface SwitchProps extends Omit<
  BaseSwitch.Root.Props,
  'className' | 'style' | 'render' | 'nativeButton' | 'children'
> {
  /** 标签文字，点击它也会切换 */
  children: ReactNode
}

/**
 * 立即生效的开关，例如 3D 预览里的“显示外层”。需要点“保存”才生效的表单改用 Checkbox（DESIGN.md §6）。
 * 轨道 40×24px、2px 边框；方块滑块打开时挪到右边，四格阶跃；打开时轨道填强调色，不只靠颜色区分
 */
export function Switch({ children, disabled, ...props }: SwitchProps) {
  return (
    <label
      className={cx(
        'group inline-flex items-center gap-2 text-base select-none',
        disabled ? 'cursor-not-allowed text-text-muted' : 'cursor-pointer text-text',
      )}
    >
      <BaseSwitch.Root
        {...props}
        disabled={disabled}
        className={cx(
          'inline-flex h-6 w-10 shrink-0 items-center rounded-sm border-2 p-0.5',
          focusRing,
          disabled
            ? 'border-border bg-surface-sunken'
            : cx(
                // 悬停时底色混入 12% 的 text，和 Checkbox 一致（DESIGN.md §2）
                '[--switch-bg:var(--color-surface)] border-border-strong',
                'data-checked:[--switch-bg:var(--color-accent)] data-checked:border-accent',
                'bg-(--switch-bg) group-hover:bg-[color-mix(in_srgb,var(--switch-bg)_88%,var(--color-text))]',
              ),
        )}
      >
        <BaseSwitch.Thumb
          className={cx(
            'size-4 rounded-none transition-transform duration-base ease-step motion-reduce:transition-none',
            'data-checked:translate-x-4',
            disabled ? 'bg-border-strong' : 'bg-border-strong data-checked:bg-accent-fg',
          )}
        />
      </BaseSwitch.Root>
      <span>{children}</span>
    </label>
  )
}
