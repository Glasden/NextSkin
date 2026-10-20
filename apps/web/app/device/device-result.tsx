import { cx } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { Check } from 'pixelarticons/react/Check.js'
import { Close } from 'pixelarticons/react/Close.js'

/** 授权或拒绝之后：告诉用户回到启动器。刚处理完和之后再打开（启动器还没来兑换）是同一个样子 */
export function DeviceResult({ status, clientName }: { status: 'approved' | 'denied'; clientName: string }) {
  const t = useTranslations('device')
  const approved = status === 'approved'
  const Icon = approved ? Check : Close
  return (
    <div role="status" className="flex flex-col items-start gap-4">
      {/* 图形也不同（勾和叉），不只靠颜色区分（DESIGN.md §9） */}
      <span
        className={cx(
          'grid size-12 place-items-center rounded-sm',
          approved ? 'bg-success text-success-fg' : 'bg-surface-sunken text-text-muted',
        )}
      >
        <Icon aria-hidden />
      </span>
      <h1 className="font-pixel text-pixel-2 text-text">{approved ? t('approvedTitle') : t('deniedTitle')}</h1>
      <p className="text-base text-pretty text-text">{approved ? t('approved') : t('denied', { name: clientName })}</p>
    </div>
  )
}
