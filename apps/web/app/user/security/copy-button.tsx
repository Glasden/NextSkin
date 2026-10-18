'use client'

import { Button, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { Copy } from 'pixelarticons/react/Copy.js'

/** 复制一段文字，结果用 Toast 告诉用户 */
export function CopyButton({ text, label, done }: { text: string; label: string; done: string }) {
  const t = useTranslations('user.security')
  const toast = useToast()
  return (
    <Button
      size="sm"
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => toast.show({ tone: 'success', title: done }),
          () => toast.show({ tone: 'danger', title: t('copyFailed') }),
        )
      }}
    >
      <Copy aria-hidden />
      {label}
    </Button>
  )
}
