import type { ReactNode } from 'react'

/** 带序号的操作步骤，序号的样式同用户中心的启动器步骤；手动升级和停服回滚共用 */
export function UpgradeSteps({ steps, footer }: { steps: ReactNode[]; footer?: ReactNode }) {
  return (
    <>
      <ol className="flex flex-col gap-4">
        {steps.map((step, index) => (
          <li key={index} className="flex gap-4">
            <span aria-hidden className="w-6 shrink-0 font-pixel text-pixel-2 text-text-muted tabular-nums">
              {index + 1}
            </span>
            <div className="flex min-w-0 flex-col gap-1 pt-1 text-sm text-pretty text-text">{step}</div>
          </li>
        ))}
      </ol>
      {footer && <p className="border-t border-border pt-4 text-sm text-pretty text-text-muted">{footer}</p>}
    </>
  )
}

/** 要在服务器上运行的一条命令 */
export function Command({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-sm bg-surface-sunken px-3 py-2 font-mono text-sm text-text">{children}</pre>
  )
}
