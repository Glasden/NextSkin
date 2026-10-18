'use client'

import type { SettingSection } from '@nextskin/domain'
import { Tabs } from '@nextskin/ui'
import { useRouter } from 'next/navigation'
import { useOptimistic, useTransition, type ReactNode } from 'react'
import { settingsHref } from './setting-text'

/** 分区切换改的是地址，服务端只读当前分区的设置。标签先切过去，内容随后换上 */
export function SettingsTabs({
  section,
  items,
  label,
  children,
}: {
  section: SettingSection
  items: readonly { value: SettingSection; label: string }[]
  label: string
  children: ReactNode
}) {
  const router = useRouter()
  const [current, setCurrent] = useOptimistic(section)
  const [, startTransition] = useTransition()
  return (
    <Tabs
      aria-label={label}
      value={current}
      onValueChange={(next) =>
        startTransition(() => {
          setCurrent(next)
          router.push(settingsHref(next))
        })
      }
      items={items}
    >
      {children}
    </Tabs>
  )
}
