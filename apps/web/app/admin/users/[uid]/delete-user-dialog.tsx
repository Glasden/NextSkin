'use client'

import { Button, Checkbox, Link } from '@nextskin/ui'
import { useFormatter, useTranslations } from 'next-intl'
import NextLink from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { sendJson } from '../../../../lib/api-client'
import { ActionDialog } from './action-dialog'

export interface DeleteUserDialogProps {
  uid: number
  nickname: string
  banned: boolean
  score: number
  players: number
  privateTextures: number
  publicTextures: number
  closetItems: number
  oauthClients: number
  /** 有 textures.manage 才能勾选"同时删除公开材质" */
  canDeleteTextures: boolean
  /** audit.retentionDays；0 是永久保留 */
  retentionDays: number
}

/**
 * 删除用户（ADR-0036"删除用户"）：确认框写明一起删掉什么、留下什么；公开材质默认留下，勾选后先逐个删除，
 * 中途失败时已经删掉的不恢复，重新提交接着删
 */
export function DeleteUserDialog({
  uid,
  nickname,
  banned,
  score,
  players,
  privateTextures,
  publicTextures,
  closetItems,
  oauthClients,
  canDeleteTextures,
  retentionDays,
}: DeleteUserDialogProps) {
  const t = useTranslations('admin.userDetail.delete')
  const format = useFormatter()
  const router = useRouter()
  const [withTextures, setWithTextures] = useState(false)

  const removed = [
    players > 0 && t('impactPlayers', { count: players }),
    privateTextures > 0 && t('impactPrivateTextures', { count: privateTextures }),
    closetItems > 0 && t('impactCloset', { count: closetItems }),
    oauthClients > 0 && t('impactOauthClients', { count: oauthClients }),
    score > 0 && t('impactScore', { score: format.number(score) }),
    withTextures && publicTextures > 0 && t('impactPublicTexturesDeleted', { count: publicTextures }),
  ].filter((item): item is string => typeof item === 'string')

  return (
    <ActionDialog
      id="admin-delete-user"
      danger
      trigger={<Button>{t('button')}</Button>}
      title={t('dialogTitle', { nickname })}
      description={t('hint')}
      confirm={t('confirm')}
      onOpen={() => setWithTextures(false)}
      send={() =>
        sendJson(
          'DELETE',
          `/api/admin/users/${uid}${withTextures && publicTextures > 0 ? '?publicTextures=delete' : ''}`,
        )
      }
      done={() => t('deleted', { nickname })}
      after={() => router.push('/admin/users')}
    >
      {removed.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-sm text-text">{t('removedTitle')}</p>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-text">
            {removed.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      {publicTextures > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-pretty text-text">
            {withTextures ? t('publicTexturesDeleteHint') : t('publicTexturesKept', { count: publicTextures })}{' '}
            <Link render={<NextLink href={`/skinlib?uploader=${uid}`} target="_blank" />}>{t('reviewTextures')}</Link>
          </p>
          {canDeleteTextures && (
            <Checkbox checked={withTextures} onCheckedChange={setWithTextures}>
              {t('deletePublicTextures', { count: publicTextures })}
            </Checkbox>
          )}
        </div>
      )}
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-pretty text-text-muted">
        {!banned && <li>{t('banFirst')}</li>}
        <li>{t('emailReusable')}</li>
        {players > 0 && retentionDays > 0 && <li>{t('uuidRetention', { days: retentionDays })}</li>}
      </ul>
    </ActionDialog>
  )
}
