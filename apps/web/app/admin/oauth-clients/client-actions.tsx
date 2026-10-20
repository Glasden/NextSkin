'use client'

import { Button, Menu, MenuItem } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { Pause } from 'pixelarticons/react/Pause.js'
import { Play } from 'pixelarticons/react/Play.js'
import { Trash } from 'pixelarticons/react/Trash.js'
import { useState } from 'react'
import { sendJson } from '../../../lib/api-client'
import { ActionDialog } from '../action-dialog'

type Dialog = 'disable' | 'enable' | 'delete'

export interface AdminClientActionsProps {
  client: {
    id: number
    /** 已经换成界面上显示的名字（公用应用、没有名称的应用） */
    name: string
    shared: boolean
    disabled: boolean
    authorizedUsers: number
    /** 有主人、配置了邮件时，停用和删除会通知主人（ADR-0037） */
    notifyOwner: boolean
  }
}

/**
 * 后台应用页每一行的操作：停用或启用、删除（ADR-0037"后台的'OAuth 应用'"）。只给能处理的应用显示（页面判断），
 * 公用应用不能删除；对话框按需挂载，每次打开都是新的状态
 */
export function AdminClientActions({ client }: AdminClientActionsProps) {
  const t = useTranslations('admin.oauthClients')
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const close = (open: boolean) => {
    if (!open) setDialog(null)
  }
  const items: Dialog[] = [client.disabled ? 'enable' : 'disable', ...(client.shared ? [] : ['delete' as const])]
  const icons = { disable: <Pause aria-hidden />, enable: <Play aria-hidden />, delete: <Trash aria-hidden /> }
  const notify = client.notifyOwner ? 'yes' : 'no'
  return (
    <>
      <Menu
        align="end"
        trigger={
          <Button size="sm" aria-label={t('manageLabel', { name: client.name })}>
            {t('manage')}
          </Button>
        }
      >
        {items.map((item) => (
          <MenuItem key={item} icon={icons[item]} onClick={() => setDialog(item)}>
            {t(item)}
          </MenuItem>
        ))}
      </Menu>
      {dialog === 'disable' && (
        <ActionDialog
          id={`admin-oauth-client-disable-${client.id}`}
          open
          onOpenChange={close}
          danger
          title={t('disableTitle', { name: client.name })}
          description={client.shared ? t('disableSharedHint') : t('disableHint', { notify })}
          confirm={t('disableConfirm')}
          send={() => sendJson('POST', `/api/admin/oauth-clients/${client.id}/disable`)}
          done={() => t('disabled', { name: client.name })}
        />
      )}
      {dialog === 'enable' && (
        <ActionDialog
          id={`admin-oauth-client-enable-${client.id}`}
          open
          onOpenChange={close}
          title={t('enableTitle', { name: client.name })}
          description={t('enableHint')}
          confirm={t('enableConfirm')}
          send={() => sendJson('POST', `/api/admin/oauth-clients/${client.id}/enable`)}
          done={() => t('enabled', { name: client.name })}
        />
      )}
      {dialog === 'delete' && (
        <ActionDialog
          id={`admin-oauth-client-delete-${client.id}`}
          open
          onOpenChange={close}
          danger
          title={t('deleteTitle', { name: client.name })}
          description={t('deleteHint', { count: client.authorizedUsers, notify })}
          confirm={t('deleteConfirm')}
          send={() => sendJson('DELETE', `/api/admin/oauth-clients/${client.id}`)}
          done={() => t('deleted', { name: client.name })}
        />
      )}
    </>
  )
}
