'use client'

import { Toast as BaseToast } from '@base-ui/react/toast'
import { CheckboxOn } from 'pixelarticons/react/CheckboxOn.js'
import { Close } from 'pixelarticons/react/Close.js'
import { InfoBox } from 'pixelarticons/react/InfoBox.js'
import { SquareAlert } from 'pixelarticons/react/SquareAlert.js'
import { WarningDiamond } from 'pixelarticons/react/WarningDiamond.js'
import { useMemo, type ReactNode } from 'react'
import { Button } from '../button/button.tsx'
import { cx } from '../cx.ts'
import { focusRing } from '../styles.ts'

type Tone = 'info' | 'success' | 'warning' | 'danger'

export interface ToastOptions {
  /** 和 Alert 相同的四种语气。warning 和 danger 会打断读屏软件，立即读出 */
  tone?: Tone
  title: ReactNode
  description?: ReactNode
  /** 一个可选的操作，例如“撤销”。点了以后通知关闭；必须读到或必须操作的内容改用 Alert（DESIGN.md §6） */
  action?: { label: string; onClick: () => void }
  /** 多少毫秒后自动关闭，0 表示不自动关闭。默认 5000；鼠标停在通知上或焦点在通知里时暂停计时 */
  timeout?: number
}

export interface ToastProviderProps {
  children: ReactNode
  /** 通知区域的名称，读屏软件用，例如“通知” */
  label: string
  /** 关闭按钮的可访问名称，例如“关闭” */
  closeLabel: string
}

interface ToastData {
  action?: ToastOptions['action']
}

// 图标和边框与 Alert 一致；info 的边框用 border-strong，浮在页面上要比 Alert 清楚一些
const tones = {
  info: { Icon: InfoBox, color: 'text-text-muted', border: 'border-border-strong' },
  success: { Icon: CheckboxOn, color: 'text-success', border: 'border-success' },
  warning: { Icon: WarningDiamond, color: 'text-warning', border: 'border-warning' },
  danger: { Icon: SquareAlert, color: 'text-danger', border: 'border-danger' },
} as const

const isTone = (type: string | undefined): type is Tone => type !== undefined && type in tones

/**
 * 操作结果的简短反馈，显示在右下角（移动端在底部），最多同时显示 3 条，新的在最下面。
 * 放在应用的最外层，里面的组件用 useToast 显示通知；按 F6 可以把焦点移到通知区域
 */
export function ToastProvider({ children, label, closeLabel }: ToastProviderProps) {
  return (
    <BaseToast.Provider>
      {children}
      <BaseToast.Portal>
        <BaseToast.Viewport
          aria-label={label}
          className={cx('fixed inset-x-4 bottom-4 z-60 flex flex-col-reverse gap-3 sm:left-auto sm:w-96', focusRing)}
        >
          <ToastList closeLabel={closeLabel} />
        </BaseToast.Viewport>
      </BaseToast.Portal>
    </BaseToast.Provider>
  )
}

/** 返回 show 和 close。只能在 ToastProvider 里面调用 */
export function useToast() {
  const { add, close } = BaseToast.useToastManager<ToastData>()
  return useMemo(
    () => ({
      /** 显示一条通知，返回它的 id */
      show({ tone = 'info', action, ...options }: ToastOptions) {
        return add({
          ...options,
          type: tone,
          priority: tone === 'warning' || tone === 'danger' ? 'high' : 'low',
          data: { action },
        })
      },
      /** 关闭指定的通知；不传 id 时关闭全部 */
      close,
    }),
    [add, close],
  )
}

function ToastList({ closeLabel }: { closeLabel: string }) {
  const { toasts, close } = BaseToast.useToastManager<ToastData>()
  return toasts.map((toast) => {
    const { Icon, color, border } = tones[isTone(toast.type) ? toast.type : 'info']
    const action = toast.data?.action
    return (
      <BaseToast.Root
        key={toast.id}
        toast={toast}
        className={cx(
          // 渲染在 body 下，不在页面的字体设置范围内，字体自己设
          'flex gap-3 rounded-md border bg-surface-raised p-4 font-sans shadow-pixel-lg data-limited:hidden',
          border,
          focusRing,
          // 进出场是四格的阶跃：上移 8px 并淡入，关闭时淡出；减少动态效果时直接出现和消失
          'transition-[opacity,translate,transform] duration-base ease-step motion-reduce:transition-none',
          'data-starting-style:translate-y-2 data-starting-style:opacity-0 data-ending-style:opacity-0',
          // 滑动关闭时从松手的位置继续滑出去。拖动中 Base UI 用行内的 transform 跟手，这里也写 transform 才能接上
          'data-ending-style:data-[swipe-direction=right]:[transform:translateX(calc(var(--toast-swipe-movement-x)+100%+1rem))]',
          'data-ending-style:data-[swipe-direction=down]:[transform:translateY(calc(var(--toast-swipe-movement-y)+100%+1rem))]',
        )}
      >
        <Icon aria-hidden className={cx('shrink-0', color)} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {/* Base UI 默认用 h2，会混进页面的标题层级 */}
          <BaseToast.Title render={<p />} className="text-base font-medium text-text" />
          <BaseToast.Description className="text-sm text-pretty text-text" />
          {action && (
            <div className="pt-2">
              <Button
                size="sm"
                onClick={() => {
                  action.onClick()
                  close(toast.id)
                }}
              >
                {action.label}
              </Button>
            </div>
          )}
        </div>
        <BaseToast.Close
          aria-label={closeLabel}
          className={cx(
            // 32px 的按钮放 24px 的图标，上移 4px 让图标和标题的第一行对齐
            'relative -mt-1 -mr-1 grid size-8 shrink-0 place-items-center rounded-sm text-text-muted',
            'hover:bg-[color-mix(in_srgb,var(--color-surface-raised)_88%,var(--color-text))] hover:text-text',
            focusRing,
            // 移动端把点击区域扩到 44px（DESIGN.md §9）
            'pointer-coarse:after:absolute pointer-coarse:after:-inset-1.5',
          )}
        >
          <Close aria-hidden />
        </BaseToast.Close>
      </BaseToast.Root>
    )
  })
}
