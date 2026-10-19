'use client'

import type { AdminClosetItem } from '@nextskin/domain'
import { Button, Field, Input } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { postJson, sendJson } from '../../../../lib/api-client'
import { ActionDialog } from '../../action-dialog'
import { TexturePreview, tidValue } from '../../texture-lookup'

/**
 * 按 tid 把材质加入用户的衣柜（ADR-0036"衣柜"）：不扣分，实付记 0，之后移出也就退 0。材质要对主人可见；
 * 输入编号时预览材质和主人能不能用，接口照样检查
 */
export function AddClosetItemDialog({ uid, nickname }: { uid: number; nickname: string }) {
  const t = useTranslations('admin.userDetail.closet')
  const [tid, setTid] = useState('')
  return (
    <ActionDialog
      id="admin-closet-add"
      fields={['tid', 'name']}
      trigger={<Button size="sm">{t('add')}</Button>}
      title={t('addTitle', { nickname })}
      description={t('addHint')}
      confirm={t('addConfirm')}
      onOpen={() => setTid('')}
      send={(values) =>
        postJson(`/api/admin/users/${uid}/closet`, {
          tid: tidValue(tid) ?? '',
          name: typeof values.name === 'string' && values.name.trim() !== '' ? values.name.trim() : undefined,
        })
      }
      done={(data) => {
        const item = data as AdminClosetItem
        return t('added', { name: item.name ?? t('hidden', { tid: item.tid }) })
      }}
    >
      <Field label={t('tid')} name="tid">
        <Input value={tid} onValueChange={setTid} inputMode="numeric" maxLength={10} required autoComplete="off" />
      </Field>
      <TexturePreview input={tid} owner={uid} />
      <Field label={t('name')} name="name" description={t('nameHint')}>
        <Input maxLength={128} autoComplete="off" />
      </Field>
    </ActionDialog>
  )
}

/** 移出：同用户自己移出，开着退款时按这一件的实付退给主人；主人名下用着它的角色换回默认皮肤，头像不动 */
export function RemoveClosetItemDialog({
  uid,
  item,
  refund,
}: {
  uid: number
  item: { tid: number; name: string; scorePaid: number }
  /** `score.refundOnDelete` */
  refund: boolean
}) {
  const t = useTranslations('admin.userDetail.closet')
  return (
    <ActionDialog
      id={`admin-closet-remove-${item.tid}`}
      danger
      trigger={
        <Button size="sm" aria-label={t('removeLabel', { name: item.name })}>
          {t('remove')}
        </Button>
      }
      title={t('removeTitle', { name: item.name })}
      description={t('removeHint', { refund: refund ? item.scorePaid : 0 })}
      confirm={t('removeConfirm')}
      send={() => sendJson('DELETE', `/api/admin/users/${uid}/closet/${item.tid}`)}
      done={(data) => t('removed', { name: item.name, refunded: (data as { refunded: number }).refunded })}
    />
  )
}
