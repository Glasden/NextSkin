'use client'

import { Alert, Button } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { Download } from 'pixelarticons/react/Download.js'
import { CopyButton } from './copy-button'

/** 刚生成的备用码：只显示这一次，可以复制或下载成文本文件 */
export function BackupCodes({ codes, siteName }: { codes: string[]; siteName: string }) {
  const t = useTranslations('user.security.backupCodes')
  const text = [t('fileHeader', { siteName }), '', ...codes, ''].join('\n')

  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = t('fileName')
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex flex-col gap-4">
      <Alert tone="warning">{t('onlyOnce')}</Alert>
      <ol
        aria-label={t('label')}
        className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-sm border border-border bg-surface-sunken px-4 py-3 font-mono text-sm text-text tabular-nums"
      >
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-3">
        <CopyButton text={codes.join('\n')} label={t('copy')} done={t('copied')} />
        <Button size="sm" onClick={download}>
          <Download aria-hidden />
          {t('download')}
        </Button>
      </div>
    </div>
  )
}
