'use client'

import { Button, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { apiError, postJson, sendJson } from '../../../lib/api-client'
import { ActionDialog } from '../action-dialog'

/** 一个失败的核心任务：重试（放回队列，当场生效）、删除（不可恢复，先确认）。不能重试的只给删除（ADR-0051） */
export function FailedJobActions({ id, retryable }: { id: number; retryable: boolean }) {
  const t = useTranslations('admin.failedJobs')
  const admin = useTranslations('admin')
  const router = useRouter()
  const toast = useToast()
  const [retrying, setRetrying] = useState(false)

  async function retry() {
    setRetrying(true)
    const { status, data } = await sendJson('POST', `/api/admin/failed-jobs/${id}/retry`)
    setRetrying(false)
    if (status === 200) toast.show({ tone: 'success', title: t('retried') })
    else toast.show({ tone: 'danger', title: apiError(data)?.message ?? admin('failed') })
    router.refresh()
  }

  return (
    <span className="flex gap-2">
      {retryable && (
        <Button size="sm" loading={retrying} onClick={() => void retry()}>
          {t('retry')}
        </Button>
      )}
      <ActionDialog
        id={`admin-failed-job-delete-${id}`}
        danger
        trigger={
          <Button size="sm" variant="secondary">
            {t('delete')}
          </Button>
        }
        title={t('deleteTitle', { id })}
        description={t('deleteHint')}
        confirm={t('delete')}
        send={() => sendJson('DELETE', `/api/admin/failed-jobs/${id}`)}
        done={() => t('deleted', { id })}
      />
    </span>
  )
}

/**
 * 全部重试、全部删除（ADR-0051）：只处理编号不大于 through 的，through 是页面打开时最新的一条。
 * 之后才失败的任务管理员还没看过，不跟着一起处理
 */
export function FailedJobsBulkActions({ through, total }: { through: number; total: number }) {
  const t = useTranslations('admin.failedJobs')
  return (
    <span className="flex gap-2">
      <ActionDialog
        id="admin-failed-jobs-retry-all"
        trigger={<Button size="sm">{t('retryAll')}</Button>}
        title={t('retryAllTitle')}
        description={t('retryAllHint')}
        confirm={t('retryAll')}
        send={() => postJson('/api/admin/failed-jobs/retry', { through })}
        done={(data) => t('retriedAll', data as { retried: number; skipped: number })}
      />
      <ActionDialog
        id="admin-failed-jobs-delete-all"
        danger
        trigger={
          <Button size="sm" variant="secondary">
            {t('deleteAll')}
          </Button>
        }
        title={t('deleteAllTitle', { count: total })}
        description={t('deleteAllHint')}
        confirm={t('deleteAll')}
        send={() => sendJson('DELETE', `/api/admin/failed-jobs?through=${through}`)}
        done={(data) => t('deletedAll', data as { deleted: number })}
      />
    </span>
  )
}
