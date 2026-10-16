import type { ButtonHTMLAttributes } from 'react'
import { cx } from './cx'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly tone?: 'default' | 'accent' | 'danger'
}

const tones = {
  default: 'border-border-strong bg-surface-raised text-text',
  accent: 'border-border-strong bg-accent text-accent-fg',
  danger: 'border-border-strong bg-danger text-danger-fg',
} as const

export function Button({ tone = 'default', className, type = 'button', ...props }: ButtonProps) {
  return (
    <button
      type={type}
      data-ui="button"
      className={cx(
        'inline-flex items-center gap-2 rounded-md border-2 px-3 py-1 text-sm shadow-pixel',
        'active:translate-x-0.5 active:translate-y-0.5 active:shadow-none',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        tones[tone],
        className,
      )}
      {...props}
    />
  )
}
