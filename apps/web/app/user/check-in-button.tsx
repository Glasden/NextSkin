'use client'

import { Button, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { apiError, sendJson } from '../../lib/api-client'

/** 仪表盘的签到按钮。签到之后刷新页面，积分、下次签到时间和积分变动都由服务端重新渲染 */
export function CheckInButton({ available }: { available: boolean }) {
  const t = useTranslations('user.dashboard')
  const router = useRouter()
  const toast = useToast()
  const [pending, setPending] = useState(false)

  async function checkIn() {
    setPending(true)
    const { status, data } = await sendJson('POST', '/api/user/check-in')
    if (status === 200) {
      const { delta } = data as { delta: number }
      toast.show({ tone: 'success', title: t('checkInSuccess', { delta }) })
    } else {
      toast.show({ tone: 'danger', title: apiError(data)?.message ?? t('checkInFailed') })
    }
    router.refresh()
    setPending(false)
  }

  return (
    <Button variant="primary" fullWidth disabled={!available} loading={pending} onClick={() => void checkIn()}>
      {available ? t('checkIn') : t('checkedIn')}
    </Button>
  )
}
