'use client'

import { Button, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { apiError, sendJson } from '../../../lib/api-client'

/** 清除头像：换回占位。设头像在衣柜和材质详情页里（ADR-0026） */
export function ClearAvatarButton() {
  const t = useTranslations('user.profile.summary')
  const router = useRouter()
  const toast = useToast()
  const [pending, setPending] = useState(false)

  async function clear() {
    setPending(true)
    const { status, data } = await sendJson('PATCH', '/api/user', { avatar: null })
    setPending(false)
    if (status === 200) toast.show({ tone: 'success', title: t('avatarCleared') })
    else toast.show({ tone: 'danger', title: apiError(data)?.message ?? t('avatarFailed') })
    router.refresh()
  }

  return (
    <Button size="sm" loading={pending} onClick={() => void clear()}>
      {t('clearAvatar')}
    </Button>
  )
}
