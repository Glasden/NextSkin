'use client'

import { Alert, Button, Dialog, DialogClose, Link, Panel, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import NextLink from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { apiError, sendJson } from '../../../lib/api-client'
import { EditTextureDialog, type OwnerTexture } from './owner-actions'

export interface AdminTexture extends Omit<OwnerTexture, 'public'> {
  public: boolean
  /** 上传者已注销：能改、能删，不能下架（ADR-0036"下架"） */
  uploaderGone: boolean
}

export interface AdminImpact {
  /** 收藏数，即所有人的衣柜项数：删除时都会移除 */
  likes: number
  pendingReports: number
  /** 上传者之外的人的衣柜项数：下架时移除 */
  othersInCloset: number
}

/**
 * 有 textures.manage 的人管理别人的材质（ADR-0027、ADR-0036"别人的材质"）：编辑名字、模型和描述，下架公开材质，删除。
 * 下架和删除的确认框写明后果（DESIGN.md §7），退不退衣柜费按 `score.refundOnDelete` 写
 */
export function TextureAdminActions({
  texture,
  impact,
  refund,
  nameRegex,
  uploader,
}: {
  texture: AdminTexture
  impact: AdminImpact
  refund: boolean
  nameRegex: string
  /** 链接到上传者在后台的详情页；上传者已注销或查看者没有 users.ban 时不传 */
  uploader: { uid: number; nickname: string } | null
}) {
  const t = useTranslations('skinlib.admin')
  return (
    <Panel as="section" tone="inset" padding="md" gap={3}>
      <div className="flex flex-col gap-1">
        <h2 className="font-pixel text-pixel-1 text-text-muted">{t('title')}</h2>
        <p className="text-sm text-text-muted">{t('description')}</p>
      </div>
      {uploader && (
        <span className="text-sm">
          <Link render={<NextLink href={`/admin/users/${uploader.uid}`} />}>
            {t('uploader', { nickname: uploader.nickname })}
          </Link>
        </span>
      )}
      {texture.public && texture.uploaderGone && <p className="text-sm text-text-muted">{t('uploaderGoneHint')}</p>}
      <div className="flex flex-wrap gap-2">
        <EditTextureDialog texture={texture} nameRegex={nameRegex} endpoint={`/api/admin/textures/${texture.tid}`} />
        {texture.public && !texture.uploaderGone && (
          <UnpublishDialog texture={texture} closets={impact.othersInCloset} refund={refund} />
        )}
        <DeleteDialog texture={texture} impact={impact} refund={refund} />
      </div>
    </Panel>
  )
}

/** 下架：改成私有，连带效果同上传者自己改私有；不动上传者的积分。拦不住上传者重新公开，处置违规内容请删除 */
function UnpublishDialog({ texture, closets, refund }: { texture: AdminTexture; closets: number; refund: boolean }) {
  const t = useTranslations('skinlib.admin')
  const common = useTranslations('common')
  const router = useRouter()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)

  async function unpublish() {
    setPending(true)
    const { status, data } = await sendJson('POST', `/api/admin/textures/${texture.tid}/unpublish`)
    setPending(false)
    setOpen(false)
    if (status === 200) toast.show({ tone: 'success', title: t('unpublished', { name: texture.name }) })
    else toast.show({ tone: 'danger', title: apiError(data)?.message ?? t('failed') })
    router.refresh()
  }

  return (
    <Dialog
      alert
      open={open}
      onOpenChange={setOpen}
      trigger={<Button size="sm">{t('unpublish')}</Button>}
      title={t('unpublishTitle', { name: texture.name })}
      description={t('unpublishHint', { closets, refund: refund ? 'yes' : 'no' })}
      actions={
        <>
          <DialogClose>{common('cancel')}</DialogClose>
          <Button variant="danger" loading={pending} onClick={() => void unpublish()}>
            {t('unpublishConfirm')}
          </Button>
        </>
      }
    >
      <Alert tone="warning">{t('unpublishWarning')}</Alert>
    </Dialog>
  )
}

/** 删除：从衣柜里移除（开着退款时退衣柜费），上传者的存储费不退，这个材质上待处理的举报一并采纳（ADR-0027） */
function DeleteDialog({ texture, impact, refund }: { texture: AdminTexture; impact: AdminImpact; refund: boolean }) {
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
    <Dialog
      alert
      open={open}
      onOpenChange={setOpen}
      // 打开确认框的按钮不用 danger，不可逆的那一步才用（DESIGN.md §6）
      trigger={<Button size="sm">{t('delete')}</Button>}
      title={t('deleteTitle', { name: texture.name })}
      description={t('deleteHint', {
        closets: impact.likes,
        reports: impact.pendingReports,
        refund: refund ? 'yes' : 'no',
      })}
      actions={
        <>
          <DialogClose>{common('cancel')}</DialogClose>
          <Button variant="danger" loading={pending} onClick={() => void remove()}>
            {t('deleteConfirm')}
          </Button>
        </>
      }
    />
  )
}
