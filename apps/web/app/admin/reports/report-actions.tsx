'use client'

import { Button, Dialog, DialogClose, Menu, MenuItem, MenuSeparator, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { Close } from 'pixelarticons/react/Close.js'
import { Trash } from 'pixelarticons/react/Trash.js'
import { UserX } from 'pixelarticons/react/UserX.js'
import { useState } from 'react'
import { apiError, sendJson } from '../../../lib/api-client'

type Action = 'dismiss' | 'deleteTexture' | 'banUploader'

export interface PendingReport {
  id: number
  /** 举报人付的花费：采纳时退还，驳回时不退 */
  paid: number
  /** 举报人已注销时不退也不奖 */
  reporterGone: boolean
  texture: {
    name: string
    /** 收藏了它的衣柜数：删除时从这些衣柜里移除，开着 score.refundOnDelete 时退还衣柜费 */
    closets: number
    /** 这个材质上另外几条待处理的举报：删除时一并采纳 */
    others: number
  }
  /** 上传者的昵称；已注销为 null */
  uploader: string | null
  /** 上传者还在、并且角色比自己低 */
  canBan: boolean
}

/**
 * 一条待处理举报的“处理”菜单：驳回、删除材质、封禁上传者（ADR-0027）。
 * 每一项都打开确认框写明后果（DESIGN.md §7）；有人抢先处理了，接口返回 409，提示后刷新列表
 */
export function ReportActions({
  report,
  reward,
  refund: refundCloset,
}: {
  report: PendingReport
  reward: number
  /** `score.refundOnDelete`：删除材质时退不退收藏者的衣柜费 */
  refund: boolean
}) {
  const t = useTranslations('admin.reports')
  const admin = useTranslations('admin')
  const common = useTranslations('common')
  const router = useRouter()
  const toast = useToast()
  const [dialog, setDialog] = useState<Action | null>(null)
  const [pending, setPending] = useState(false)
  const refund = report.reporterGone ? 0 : report.paid
  const award = report.reporterGone ? 0 : reward

  async function resolve(action: Action) {
    setPending(true)
    const { status, data } = await sendJson('POST', `/api/admin/reports/${report.id}/resolve`, { action })
    setPending(false)
    setDialog(null)
    if (status === 200) {
      toast.show({
        tone: 'success',
        title:
          action === 'dismiss'
            ? t('dismissed', { id: report.id })
            : action === 'deleteTexture'
              ? t('deleted', { name: report.texture.name, others: report.texture.others })
              : t('banned', { nickname: report.uploader ?? '' }),
      })
    } else {
      toast.show({ tone: 'danger', title: apiError(data)?.message ?? admin('failed') })
    }
    router.refresh()
  }

  const dialogs: Record<Action, { title: string; description: string; confirm: string }> = {
    dismiss: {
      title: t('dismissTitle', { name: report.texture.name }),
      description: t('dismissHint', { paid: refund }),
      confirm: t('dismissConfirm'),
    },
    deleteTexture: {
      title: t('deleteTitle', { name: report.texture.name }),
      description: t('deleteHint', {
        closets: report.texture.closets,
        others: report.texture.others,
        paid: refund,
        reward: award,
        refund: refundCloset ? 'yes' : 'no',
      }),
      confirm: t('deleteConfirm'),
    },
    banUploader: {
      title: t('banTitle', { nickname: report.uploader ?? '' }),
      description: t('banHint', { paid: refund, reward: award }),
      confirm: t('banConfirm'),
    },
  }
  const current = dialog ? dialogs[dialog] : null

  return (
    <>
      <Menu
        align="end"
        trigger={
          <Button size="sm" aria-label={t('handleLabel', { id: report.id })}>
            {t('handle')}
          </Button>
        }
      >
        <MenuItem icon={<Close aria-hidden />} onClick={() => setDialog('dismiss')}>
          {t('dismiss')}
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={<Trash aria-hidden />} onClick={() => setDialog('deleteTexture')}>
          {t('deleteTexture')}
        </MenuItem>
        <MenuItem icon={<UserX aria-hidden />} disabled={!report.canBan} onClick={() => setDialog('banUploader')}>
          {t('banUploader')}
        </MenuItem>
      </Menu>
      {current && dialog && (
        <Dialog
          alert
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null)
          }}
          title={current.title}
          description={current.description}
          actions={
            <>
              <DialogClose>{common('cancel')}</DialogClose>
              <Button
                variant={dialog === 'dismiss' ? 'primary' : 'danger'}
                loading={pending}
                onClick={() => void resolve(dialog)}
              >
                {current.confirm}
              </Button>
            </>
          }
        />
      )}
    </>
  )
}
