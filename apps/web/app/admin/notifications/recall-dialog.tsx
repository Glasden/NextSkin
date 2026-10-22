'use client'

import { Button } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { sendJson } from '../../../lib/api-client'
import { ActionDialog } from '../action-dialog'

/** 撤回一次发送（ADR-0052）：收件人那边立即看不到，读过的也一样；发送记录留着，状态改成已撤回 */
export function RecallDialog({ id, title }: { id: number; title: string }) {
  const t = useTranslations('admin.notifications')
  return (
    <ActionDialog
      id={`admin-notification-recall-${id}`}
      danger
      trigger={
        <Button size="sm" variant="secondary">
          {t('recall')}
        </Button>
      }
      title={t('recallTitle', { title })}
      description={t('recallHint')}
      confirm={t('recall')}
      send={() => sendJson('POST', `/api/admin/notifications/${id}/recall`)}
      done={() => t('recalled', { title })}
    />
  )
}
