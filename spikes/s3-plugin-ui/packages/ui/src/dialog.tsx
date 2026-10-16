'use client'
import { Dialog as Base } from '@base-ui/react/dialog'
import type { ReactNode } from 'react'
import { Button } from './button'

export interface DialogProps {
  readonly trigger: ReactNode
  readonly title: ReactNode
  readonly children: ReactNode
}

export function Dialog({ trigger, title, children }: DialogProps) {
  return (
    <Base.Root>
      <Base.Trigger render={<Button />}>{trigger}</Base.Trigger>
      <Base.Portal>
        <Base.Backdrop className="fixed inset-0 bg-shadow/40" />
        <Base.Popup
          data-ui="dialog"
          className="fixed top-1/2 left-1/2 w-80 -translate-x-1/2 -translate-y-1/2 rounded-md border-2 border-border-strong bg-surface-raised p-6 text-text shadow-pixel-lg"
        >
          <Base.Title className="mb-2 text-lg font-semibold">{title}</Base.Title>
          <div className="mb-4">{children}</div>
          <Base.Close render={<Button />}>关闭</Base.Close>
        </Base.Popup>
      </Base.Portal>
    </Base.Root>
  )
}
