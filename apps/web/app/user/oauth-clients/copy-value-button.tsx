'use client'

import { IconButton, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { Copy } from 'pixelarticons/react/Copy.js'

/** 复制 client_id、密钥、发现文档的地址。label 写明复制的是什么，既是按钮的名称也是提示 */
export function CopyValueButton({ value, label, done }: { value: string; label: string; done: string }) {
  const t = useTranslations('user.oauthClients')
  const toast = useToast()
  return (
    <IconButton
      label={label}
      size="sm"
      onClick={() => {
        // 剪贴板接口只在 HTTPS（和 localhost）下可用，自己架设的站点常常是 HTTP。这时提示手动复制，值本身可以选中
        const copied = window.isSecureContext
          ? navigator.clipboard.writeText(value)
          : Promise.reject(new Error('insecure context'))
        void copied.then(
          () => toast.show({ tone: 'success', title: done }),
          () => toast.show({ tone: 'danger', title: t('copyFailed') }),
        )
      }}
    >
      <Copy />
    </IconButton>
  )
}
