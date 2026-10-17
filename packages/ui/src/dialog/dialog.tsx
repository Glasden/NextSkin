'use client'

import { AlertDialog } from '@base-ui/react/alert-dialog'
import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import type { ReactElement, ReactNode } from 'react'
import { Button } from '../button/button.tsx'

export interface DialogProps {
  /** 打开对话框的按钮，例如 `<Button>添加角色</Button>`。不传时用 open 和 onOpenChange 控制 */
  trigger?: ReactElement
  open?: boolean
  onOpenChange?: (open: boolean) => void
  title: ReactNode
  /** 危险操作写明后果，例如“删除后退还 100 积分，无法恢复”（DESIGN.md §7） */
  description?: ReactNode
  /** 对话框的主体，例如一个 Form */
  children?: ReactNode
  /**
   * 底部的操作：先写 DialogClose（取消），再写确认按钮。确认按钮写具体动作，例如“删除角色”，不写“确定”。
   * 表单的提交按钮放在这里时，用 `form` 属性关联表单
   */
  actions: ReactNode
  /** 确认不可逆的操作：点对话框外面不会关闭，读屏软件按 alertdialog 朗读 */
  alert?: boolean
}

/**
 * 需要用户做决定、并且应当打断当前流程的对话框。打开时焦点限制在框内，落在第一个可以聚焦的元素上；
 * 关闭后焦点回到触发它的元素（DESIGN.md §9）。展示大量内容或编辑详情改用 Sheet
 */
export function Dialog({ trigger, open, onOpenChange, title, description, children, actions, alert }: DialogProps) {
  // AlertDialog 只有 Root 和 Trigger 是自己的，其余部件就是 Dialog 的
  const Root = alert ? AlertDialog.Root : BaseDialog.Root
  const Trigger = alert ? AlertDialog.Trigger : BaseDialog.Trigger
  return (
    <Root open={open} onOpenChange={onOpenChange ? (next) => onOpenChange(next) : undefined}>
      {trigger && <Trigger render={trigger} />}
      <BaseDialog.Portal>
        <BaseDialog.Backdrop
          className={
            // 页面蒙上一层底色：亮色下变浅、暗色下变暗，对话框靠边框和硬边阴影浮起来
            'fixed inset-0 z-50 bg-[color-mix(in_srgb,var(--color-bg)_80%,transparent)] transition-opacity duration-base ease-step motion-reduce:transition-none data-ending-style:opacity-0 data-starting-style:opacity-0'
          }
        />
        <BaseDialog.Viewport className="fixed inset-0 z-50 grid place-items-center overflow-y-auto p-4">
          <BaseDialog.Popup
            className={
              // 渲染在 body 下，不在页面的字体设置范围内，字体自己设。进出场与 Toast 相同：四格阶跃，上移 8px 并淡入
              'flex w-full max-w-md flex-col gap-6 rounded-md border border-border-strong bg-surface-raised p-6 font-sans text-text shadow-pixel-lg outline-none transition-[opacity,translate] duration-base ease-step motion-reduce:transition-none data-ending-style:opacity-0 data-starting-style:translate-y-2 data-starting-style:opacity-0'
            }
          >
            <div className="flex flex-col gap-2">
              <BaseDialog.Title className="font-pixel text-pixel-2 text-text">{title}</BaseDialog.Title>
              {description && (
                <BaseDialog.Description className="text-sm text-pretty text-text">{description}</BaseDialog.Description>
              )}
            </div>
            {children}
            {/* 移动端按钮占满宽度、主要操作在最上面；桌面端靠右排成一行，主要操作在最右边 */}
            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">{actions}</div>
          </BaseDialog.Popup>
        </BaseDialog.Viewport>
      </BaseDialog.Portal>
    </Root>
  )
}

/** 关闭对话框的次要按钮，例如“取消” */
export function DialogClose({ children }: { children: ReactNode }) {
  return <BaseDialog.Close render={<Button />}>{children}</BaseDialog.Close>
}
