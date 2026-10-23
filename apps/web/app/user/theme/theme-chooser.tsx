'use client'

import { ThemePicker, useToast, type ThemePickerOption } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useOptimistic, useTransition } from 'react'
import { apiError, sendJson } from '../../../lib/api-client'

/** “跟随站点默认”这一项的值。主题 id 不是 diamond 就带斜杠（插件 id/主题名），撞不上 */
export const FOLLOW_DEFAULT = 'default'

/**
 * 挑一套主题：点一下就保存（PUT /api/user/theme），刷新后整页换上（根布局按账号输出 data-theme）。
 * 保存和刷新完成之前，选中项先挪过去；失败时回到保存前的那项
 */
export function ThemeChooser({
  options,
  selected,
  'aria-label': ariaLabel,
}: {
  options: readonly ThemePickerOption<string>[]
  selected: string
  'aria-label': string
}) {
  const t = useTranslations('user.theme')
  const router = useRouter()
  const toast = useToast()
  const [value, setValue] = useOptimistic(selected)
  const [, startTransition] = useTransition()

  function choose(next: string) {
    startTransition(async () => {
      setValue(next)
      const { status, data } = await sendJson('PUT', '/api/user/theme', {
        theme: next === FOLLOW_DEFAULT ? null : next,
      })
      if (status === 200) {
        const name = options.find((option) => option.value === next)?.name ?? next
        toast.show({ tone: 'success', title: next === FOLLOW_DEFAULT ? t('savedDefault') : t('saved', { name }) })
      } else toast.show({ tone: 'danger', title: apiError(data)?.message ?? t('saveFailed') })
      router.refresh()
    })
  }

  return <ThemePicker aria-label={ariaLabel} options={options} value={value} onValueChange={choose} />
}
