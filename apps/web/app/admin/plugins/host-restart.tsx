'use client'

import { Button, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { apiError, sendJson } from '../../../lib/api-client'

/** 手动重启 plugin host：清掉崩溃计数，按表里启用的插件起新的一代 */
export function HostRestart() {
  const t = useTranslations('admin.plugins.host')
  const admin = useTranslations('admin')
  const router = useRouter()
  const toast = useToast()
  const [pending, setPending] = useState(false)

  async function restart() {
    setPending(true)
    const { status, data } = await sendJson('POST', '/api/admin/plugin-host/restart')
    setPending(false)
    if (status === 200) toast.show({ tone: 'success', title: t('restarted') })
    else toast.show({ tone: 'danger', title: apiError(data)?.message ?? admin('failed') })
    router.refresh()
  }

  return (
    <Button size="sm" loading={pending} onClick={() => void restart()}>
      {t('restart')}
    </Button>
  )
}
