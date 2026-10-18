'use client'

import { Button, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { Copy } from 'pixelarticons/react/Copy.js'

/**
 * 复制外置登录的 API 地址。按钮本身也能拖进启动器：authlib-injector 的拖放规范是在 dragstart 里
 * 放一段 `authlib-injector:yggdrasil-server:<编码后的地址>` 文本，支持拖放的启动器收到后直接添加服务器
 */
export function LauncherCopyButton({ apiUrl }: { apiUrl: string }) {
  const t = useTranslations('user.dashboard.launcher')
  const toast = useToast()
  return (
    <Button
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', `authlib-injector:yggdrasil-server:${encodeURIComponent(apiUrl)}`)
        event.dataTransfer.dropEffect = 'copy'
      }}
      onClick={() => {
        // 剪贴板接口只在 HTTPS（和 localhost）下可用；自己架设的站点常常是 HTTP，这时提示手动复制
        const copied = window.isSecureContext
          ? navigator.clipboard.writeText(apiUrl)
          : Promise.reject(new Error('insecure context'))
        void copied.then(
          () => toast.show({ tone: 'success', title: t('copied') }),
          () => toast.show({ tone: 'danger', title: t('copyFailed') }),
        )
      }}
    >
      <Copy aria-hidden />
      {t('copy')}
    </Button>
  )
}
