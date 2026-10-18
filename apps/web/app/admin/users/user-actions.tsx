'use client'

import type { UserRole } from '@nextskin/domain'
import { Button, Dialog, DialogClose, Menu, MenuItem, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { Shield } from 'pixelarticons/react/Shield.js'
import { User } from 'pixelarticons/react/User.js'
import { UserPlus } from 'pixelarticons/react/UserPlus.js'
import { UserX } from 'pixelarticons/react/UserX.js'
import { useState, type ReactNode } from 'react'
import { apiError, sendJson } from '../../../lib/api-client'
import { roleChangeTargets, type RoleChange } from './role-changes'

/**
 * 用户列表一行的“管理”菜单：封禁、解封、设为或取消管理员。只给角色比自己低的用户显示（页面判断），
 * 每一项都打开确认框写明后果（DESIGN.md §7）
 */
export function UserActions({
  user,
  changes,
}: {
  user: { uid: number; nickname: string; role: UserRole }
  changes: readonly RoleChange[]
}) {
  const t = useTranslations('admin.users')
  const admin = useTranslations('admin')
  const common = useTranslations('common')
  const router = useRouter()
  const toast = useToast()
  const [dialog, setDialog] = useState<RoleChange | null>(null)
  const [pending, setPending] = useState(false)
  if (!changes.length) return null

  async function apply(change: RoleChange) {
    setPending(true)
    const { status, data } = await sendJson('PATCH', `/api/admin/users/${user.uid}`, {
      role: roleChangeTargets[change],
    })
    setPending(false)
    setDialog(null)
    const done = { ban: 'banned', unban: 'unbanned', appoint: 'appointed', revoke: 'revoked' } as const
    if (status === 200) toast.show({ tone: 'success', title: t(done[change], { nickname: user.nickname }) })
    else toast.show({ tone: 'danger', title: apiError(data)?.message ?? admin('failed') })
    router.refresh()
  }

  const icons: Record<RoleChange, ReactNode> = {
    ban: <UserX aria-hidden />,
    unban: <UserPlus aria-hidden />,
    appoint: <Shield aria-hidden />,
    revoke: <User aria-hidden />,
  }
  const dialogs: Record<RoleChange, { description: string; danger: boolean }> = {
    ban: { description: t('banHint', { admin: String(user.role === 'admin') }), danger: true },
    unban: { description: t('unbanHint'), danger: false },
    appoint: { description: t('appointHint'), danger: false },
    revoke: { description: t('revokeHint'), danger: true },
  }

  return (
    <>
      <Menu
        align="end"
        trigger={
          <Button size="sm" aria-label={t('manageLabel', { nickname: user.nickname })}>
            {t('manage')}
          </Button>
        }
      >
        {changes.map((change) => (
          <MenuItem key={change} icon={icons[change]} onClick={() => setDialog(change)}>
            {t(change)}
          </MenuItem>
        ))}
      </Menu>
      {dialog && (
        <Dialog
          alert
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null)
          }}
          title={t(`${dialog}Title`, { nickname: user.nickname })}
          description={dialogs[dialog].description}
          actions={
            <>
              <DialogClose>{common('cancel')}</DialogClose>
              <Button
                variant={dialogs[dialog].danger ? 'danger' : 'primary'}
                loading={pending}
                onClick={() => void apply(dialog)}
              >
                {t(`${dialog}Confirm`)}
              </Button>
            </>
          }
        />
      )}
    </>
  )
}
