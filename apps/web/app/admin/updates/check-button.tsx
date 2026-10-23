'use client'

import { Button, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { apiError, sendJson } from '../../../lib/api-client'

/** 立即检查一次（ADR-0061）。30 秒内刚检查过时核心直接返回现有结果，连点也不会反复出站 */
export function UpdateCheckButton() {
  const t = useTranslations('admin.updates')
  const admin = useTranslations('admin')
  const router = useRouter()
  const toast = useToast()
  const [checking, setChecking] = useState(false)

  async function check() {
    setChecking(true)
    const { status, data } = await sendJson('POST', '/api/admin/updates/check')
    setChecking(false)
    if (status === 200) toast.show({ tone: 'success', title: t('checked') })
    else toast.show({ tone: 'danger', title: apiError(data)?.message ?? admin('failed') })
    router.refresh()
  }

  return (
    <Button size="sm" variant="secondary" loading={checking} onClick={() => void check()}>
      {t('check')}
    </Button>
  )
}
