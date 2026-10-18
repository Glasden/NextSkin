'use client'

import { Tabs } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useOptimistic, useTransition, type ReactNode } from 'react'
import { REPORT_STATUSES, reportsHref, type ReportParams, type ReportStatus } from '../params'

/** 待处理、已采纳、已驳回：切换改的是地址，服务端只查当前这一种。标签先切过去，内容随后换上 */
export function ReportTabs({
  params,
  counts,
  children,
}: {
  params: ReportParams
  counts: Record<ReportStatus, number>
  children: ReactNode
}) {
  const t = useTranslations('admin.reports')
  const router = useRouter()
  const [status, setStatus] = useOptimistic(params.status)
  const [, startTransition] = useTransition()
  return (
    <Tabs
      aria-label={t('tabsLabel')}
      value={status}
      onValueChange={(next) =>
        startTransition(() => {
          setStatus(next)
          router.push(reportsHref(params, { status: next }))
        })
      }
      items={REPORT_STATUSES.map((value) => ({ value, label: t(`status.${value}`), count: counts[value] }))}
    >
      {children}
    </Tabs>
  )
}
