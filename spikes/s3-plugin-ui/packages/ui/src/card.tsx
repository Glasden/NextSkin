import type { HTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  readonly title?: ReactNode
  readonly tone?: 'default' | 'danger'
}

export function Card({ title, tone = 'default', className, children, ...props }: CardProps) {
  return (
    <section
      data-ui="card"
      className={cx(
        'rounded-md border-2 bg-surface p-4 shadow-pixel',
        tone === 'danger' ? 'border-danger' : 'border-border',
        className,
      )}
      {...props}
    >
      {title ? <h3 className="mb-2 text-sm font-semibold text-text">{title}</h3> : null}
      {children}
    </section>
  )
}
