'use client'

import { Tabs } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useOptimistic, useTransition, type ReactNode } from 'react'
import { closetHref, type ClosetParams } from './params'

/** 皮肤和披风两个分类：切换改的是地址，服务端只查当前这一类。标签先切过去，内容随后换上 */
export function ClosetTabs({
  params,
  counts,
  children,
}: {
  params: ClosetParams
  counts: Record<ClosetParams['type'], number>
  children: ReactNode
}) {
  const t = useTranslations('user.closet')
  const router = useRouter()
  const [type, setType] = useOptimistic(params.type)
  const [, startTransition] = useTransition()
  return (
    <Tabs
      aria-label={t('tabsLabel')}
      value={type}
      onValueChange={(next) =>
        startTransition(() => {
          setType(next)
          // 搜索词留着：换个分类接着找
          router.push(closetHref(params, { type: next }))
        })
      }
      items={(['skin', 'cape'] as const).map((value) => ({
        value,
        label: t(`tabs.${value}`),
        count: counts[value],
      }))}
    >
      {children}
    </Tabs>
  )
}
