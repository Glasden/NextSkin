import type { ReactNode } from 'react'
import { Alert } from '../alert/alert.tsx'
import { Button } from '../button/button.tsx'
import { LoadingDots } from '../loading-dots.tsx'

export interface CaptchaFrameProps {
  /** loading：服务商的脚本还没到；ready：挂件已经渲染；error：脚本加载失败，显示原因和重试 */
  status: 'loading' | 'ready' | 'error'
  /** 读屏软件读出的名称，例如“人机验证” */
  label: string
  /** 加载中显示的文字，例如“正在加载验证码” */
  loadingText: string
  /** 加载失败的说明：发生了什么、用户能做什么（DESIGN.md §7），例如要能访问哪家服务商 */
  error?: ReactNode
  /** 重试按钮的文字；不传 onRetry 时不显示按钮 */
  retryLabel?: string
  onRetry?: () => void
  /** 服务商的脚本往里面渲染挂件的元素，由调用方提供 */
  children: ReactNode
}

/**
 * 第三方验证码挂件（Turnstile、hCaptcha、reCAPTCHA）的外框，放在表单的提交按钮上方（ADR-0038）。
 * 挂件本身的样子由服务商决定；外框只管它出来之前和加载失败时占住的位置，纯展示，可以在服务端渲染
 */
export function CaptchaFrame({ status, label, loadingText, error, retryLabel, onRetry, children }: CaptchaFrameProps) {
  return (
    <div role="group" aria-label={label} aria-busy={status === 'loading'} className="flex flex-col">
      {/* 挂件的容器一直挂在页面上：服务商的脚本拿着这个元素渲染，切换状态时不能卸载它 */}
      <div hidden={status !== 'ready'}>{children}</div>
      {status === 'loading' && (
        // 和复选框式的挂件差不多大（约 300×78），挂件出来时页面不跳
        <div className="flex h-20 w-76 max-w-full items-center gap-3 rounded-sm border border-dashed border-border bg-surface-sunken px-4 text-sm text-text-muted">
          <LoadingDots />
          {loadingText}
        </div>
      )}
      {status === 'error' && (
        <Alert tone="danger">
          <div className="flex flex-col items-start gap-3">
            <span>{error}</span>
            {onRetry && (
              <Button size="sm" onClick={onRetry}>
                {retryLabel}
              </Button>
            )}
          </div>
        </Alert>
      )}
    </div>
  )
}
