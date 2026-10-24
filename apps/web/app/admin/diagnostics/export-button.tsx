'use client'

import { Button, Dialog, DialogClose, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { apiError } from '../../../lib/api-client'

const FALLBACK_NAME = 'nextskin-diagnostics.zip'

/** Content-Disposition 里的文件名；服务端只用 ASCII 的文件名，不需要处理 filename* */
function attachmentName(header: string | null): string {
  return /filename="([^"]+)"/u.exec(header ?? '')?.[1] ?? FALLBACK_NAME
}

/**
 * 导出诊断包（ADR-0062）：先说明包里有什么、哪些会被替换，提醒发出去之前自己看一遍，确认后用 POST 下载。
 * 带 JSON 的 Content-Type，同 sendJson：跨站的页面发不出这种请求
 */
export function ExportButton() {
  const t = useTranslations('admin.diagnostics.export')
  const admin = useTranslations('admin')
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [sending, setSending] = useState(false)

  async function download() {
    setSending(true)
    try {
      const response = await fetch('/api/admin/diagnostics/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      if (!response.ok) {
        const data: unknown = await response.json().catch(() => null)
        toast.show({ tone: 'danger', title: apiError(data)?.message ?? admin('failed') })
        return
      }
      const url = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = url
      link.download = attachmentName(response.headers.get('Content-Disposition'))
      link.click()
      // 点击之后浏览器才开始读这个地址，等一轮再释放
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setOpen(false)
      toast.show({ tone: 'success', title: t('done') })
    } catch {
      toast.show({ tone: 'danger', title: admin('failed') })
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={<Button variant="primary">{t('open')}</Button>}
      title={t('title')}
      description={t('description')}
      actions={
        <>
          <DialogClose>{t('cancel')}</DialogClose>
          <Button variant="primary" loading={sending} onClick={() => void download()}>
            {t('confirm')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm text-text">
        <ul className="flex list-disc flex-col gap-1 pl-5">
          <li>{t('contents.summary')}</li>
          <li>{t('contents.settings')}</li>
          <li>{t('contents.environment')}</li>
          <li>{t('contents.logs')}</li>
        </ul>
        <p className="text-pretty">{t('redaction')}</p>
        <p className="text-pretty text-text-muted">{t('review')}</p>
      </div>
    </Dialog>
  )
}
