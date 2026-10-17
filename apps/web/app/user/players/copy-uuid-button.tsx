'use client'

import { IconButton, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { Copy } from 'pixelarticons/react/Copy.js'

/** 服主加白名单、查数据时要用 UUID */
export function CopyUuidButton({ uuid, name }: { uuid: string; name: string }) {
  const t = useTranslations('user.players')
  const toast = useToast()
  return (
    <IconButton
      label={t('copyUuid')}
      size="sm"
      onClick={() => {
        // 剪贴板接口只在 HTTPS（和 localhost）下可用，自己架设的站点常常是 HTTP。这时提示手动复制，UUID 本身可以选中
        const copied = window.isSecureContext
          ? navigator.clipboard.writeText(uuid)
          : Promise.reject(new Error('insecure context'))
        void copied.then(
          () => toast.show({ title: t('copied', { name }) }),
          () => toast.show({ tone: 'danger', title: t('copyFailed') }),
        )
      }}
    >
      <Copy />
    </IconButton>
  )
}
