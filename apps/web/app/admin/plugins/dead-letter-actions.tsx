'use client'

import { Button, Dialog, DialogClose, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { apiError, sendJson } from '../../../lib/api-client'

/** 一个失败的任务：重试（放回队列，当场生效）、删除（不可恢复，先确认） */
export function DeadLetterActions({ pluginId, jobId }: { pluginId: string; jobId: number }) {
  const t = useTranslations('admin.plugins.deadLetters')
  const admin = useTranslations('admin')
  const common = useTranslations('common')
  const router = useRouter()
  const toast = useToast()
  const [pending, setPending] = useState<'retry' | 'delete' | null>(null)
  const [confirming, setConfirming] = useState(false)
  const base = `/api/admin/plugins/${pluginId}/dead-letters/${jobId}`

  async function run(action: 'retry' | 'delete') {
    setPending(action)
    const { status, data } =
      action === 'retry' ? await sendJson('POST', `${base}/retry`) : await sendJson('DELETE', base)
    setPending(null)
    setConfirming(false)
    if (status === 200)
      toast.show({ tone: 'success', title: action === 'retry' ? t('retried') : t('deleted', { id: jobId }) })
    else toast.show({ tone: 'danger', title: apiError(data)?.message ?? admin('failed') })
    router.refresh()
  }

  return (
    <span className="flex gap-2">
      <Button size="sm" loading={pending === 'retry'} onClick={() => void run('retry')}>
        {t('retry')}
      </Button>
      <Button size="sm" variant="secondary" onClick={() => setConfirming(true)}>
        {t('delete')}
      </Button>
      {confirming && (
        <Dialog
          alert
          open
          onOpenChange={(open) => {
            if (!open) setConfirming(false)
          }}
          title={t('deleteTitle', { id: jobId })}
          description={t('deleteHint')}
          actions={
            <>
              <DialogClose>{common('cancel')}</DialogClose>
              <Button variant="danger" loading={pending === 'delete'} onClick={() => void run('delete')}>
                {t('delete')}
              </Button>
            </>
          }
        />
      )}
    </span>
  )
}
