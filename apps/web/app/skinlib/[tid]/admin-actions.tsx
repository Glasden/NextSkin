'use client'

import { Button, Dialog, DialogClose, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { apiError, sendJson } from '../../../lib/api-client'

/**
 * 管理员删除别人的材质（ADR-0027）：从衣柜里移除并退还衣柜费，上传者的存储费不退，
 * 这个材质上待处理的举报一并采纳。确认框写明后果（DESIGN.md §7）
 */
export function TextureAdminActions({
  texture,
  impact,
}: {
  texture: { tid: number; name: string }
  impact: { likes: number; pendingReports: number }
}) {
  const t = useTranslations('skinlib.admin')
  const common = useTranslations('common')
  const router = useRouter()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)

  async function remove() {
    setPending(true)
    const { status, data } = await sendJson('DELETE', `/api/admin/textures/${texture.tid}`)
    setPending(false)
    setOpen(false)
    if (status === 200) {
      const { resolvedReports } = data as { resolvedReports: number }
      toast.show({ tone: 'success', title: t('deleted', { name: texture.name, reports: resolvedReports }) })
      router.push('/skinlib')
      router.refresh()
      return
    }
    toast.show({ tone: 'danger', title: apiError(data)?.message ?? t('failed') })
    router.refresh()
  }

  return (
    <section className="flex flex-col gap-3 rounded-md border border-border p-4">
      <div className="flex flex-col gap-1">
        <h2 className="font-pixel text-pixel-1 text-text-muted">{t('title')}</h2>
        <p className="text-sm text-text-muted">{t('description')}</p>
      </div>
      <div>
        <Dialog
          alert
          open={open}
          onOpenChange={setOpen}
          // 打开确认框的按钮不用 danger，不可逆的那一步才用（DESIGN.md §6）
          trigger={<Button size="sm">{t('delete')}</Button>}
          title={t('deleteTitle', { name: texture.name })}
          description={t('deleteHint', { closets: impact.likes, reports: impact.pendingReports })}
          actions={
            <>
              <DialogClose>{common('cancel')}</DialogClose>
              <Button variant="danger" loading={pending} onClick={() => void remove()}>
                {t('deleteConfirm')}
              </Button>
            </>
          }
        />
      </div>
    </section>
  )
}
