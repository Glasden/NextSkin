'use client'

import type { AdminPlayer, AdminTextureForOwner, AdminUserLookup, UserRole } from '@nextskin/domain'
import { Alert, Badge, Button, Field, Input, Menu, MenuItem, PlayerHead } from '@nextskin/ui'
import { useFormatter, useTranslations } from 'next-intl'
import { Forward } from 'pixelarticons/react/Forward.js'
import { Image } from 'pixelarticons/react/Image.js'
import { Pencil } from 'pixelarticons/react/Pencil.js'
import { Trash } from 'pixelarticons/react/Trash.js'
import { useRef, useState, type ReactNode } from 'react'
import { getJson, sendJson } from '../../../lib/api-client'
import { headSrc } from '../../../lib/textures'
import { ActionDialog } from '../action-dialog'
import { TexturePreview, tidValue, type Lookup } from '../texture-lookup'
import { roleTones } from '../users/role-changes'

type Dialog = 'rename' | 'textures' | 'transfer' | 'delete'

/**
 * 角色页每一行的操作菜单：改名、换材质、转让、删除，各打开一个确认框（ADR-0036"页面"）。
 * 只给主人身份比自己低的角色显示（页面判断）；对话框按需挂载，每次打开都是新的状态
 */
export function PlayerActions({
  player,
  emailLookup,
  mailConfigured,
}: {
  player: AdminPlayer
  emailLookup: boolean
  /** 没有配置邮件时不发通知，确认框也不提（ADR-0036"通知邮件"） */
  mailConfigured: boolean
}) {
  const t = useTranslations('admin.players')
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const close = (open: boolean) => {
    if (!open) setDialog(null)
  }
  const icons: Record<Dialog, ReactNode> = {
    rename: <Pencil aria-hidden />,
    textures: <Image aria-hidden />,
    transfer: <Forward aria-hidden />,
    delete: <Trash aria-hidden />,
  }
  return (
    <>
      <Menu
        align="end"
        trigger={
          <Button size="sm" aria-label={t('manageLabel', { name: player.name })}>
            {t('manage')}
          </Button>
        }
      >
        {(['rename', 'textures', 'transfer', 'delete'] as const).map((item) => (
          <MenuItem key={item} icon={icons[item]} onClick={() => setDialog(item)}>
            {t(item)}
          </MenuItem>
        ))}
      </Menu>
      {dialog === 'rename' && <RenameDialog player={player} mailConfigured={mailConfigured} onOpenChange={close} />}
      {dialog === 'textures' && <TexturesDialog player={player} mailConfigured={mailConfigured} onOpenChange={close} />}
      {dialog === 'transfer' && (
        <TransferDialog
          player={player}
          emailLookup={emailLookup}
          mailConfigured={mailConfigured}
          onOpenChange={close}
        />
      )}
      {dialog === 'delete' && <DeleteDialog player={player} mailConfigured={mailConfigured} onOpenChange={close} />}
    </>
  )
}

interface DialogProps {
  player: AdminPlayer
  mailConfigured: boolean
  onOpenChange: (open: boolean) => void
}

/** 改名：规则同用户自己改名，不收积分，UUID 不变（ADR-0022、不变量 2） */
function RenameDialog({ player, mailConfigured, onOpenChange }: DialogProps) {
  const t = useTranslations('admin.players')
  return (
    <ActionDialog
      id={`admin-player-rename-${player.pid}`}
      open
      onOpenChange={onOpenChange}
      fields={['name']}
      rename={{ playerName: 'name' }}
      title={t('renameTitle', { name: player.name })}
      description={t('renameHint', { mail: mailConfigured ? 'yes' : 'no' })}
      confirm={t('renameConfirm')}
      send={(values) => sendJson('PATCH', `/api/admin/players/${player.pid}`, { name: values.name })}
      done={(data) => t('renamed', { name: (data as { name: string }).name })}
    >
      <Field label={t('renameLabel')} name="name">
        <Input defaultValue={player.name} maxLength={255} required autoComplete="off" spellCheck={false} />
      </Field>
    </ActionDialog>
  )
}

/**
 * 换材质：按 tid 输入，留空清空。材质要对主人可见、类型和槽位一致；不要求在主人的衣柜里（ADR-0036"换材质"）。
 * 预览只是提示，接口照样检查
 */
function TexturesDialog({ player, onOpenChange }: DialogProps) {
  const t = useTranslations('admin.players')
  const initial = { skin: player.skin ? String(player.skin.tid) : '', cape: player.cape ? String(player.cape.tid) : '' }
  const [skin, setSkin] = useState(initial.skin)
  const [cape, setCape] = useState(initial.cape)
  // 只提交改了的槽：没动的槽按打开时的快照原样提交，会盖掉主人这期间的改动，它失效了还会让整个请求失败
  const changed = {
    ...(skin.trim() === initial.skin ? {} : { skin: tidValue(skin) }),
    ...(cape.trim() === initial.cape ? {} : { cape: tidValue(cape) }),
  }
  return (
    <ActionDialog
      id={`admin-player-textures-${player.pid}`}
      open
      onOpenChange={onOpenChange}
      fields={['skin', 'cape']}
      title={t('texturesTitle', { name: player.name })}
      description={t('texturesHint')}
      confirm={t('texturesConfirm')}
      confirmDisabled={Object.keys(changed).length === 0}
      send={() => sendJson('PATCH', `/api/admin/players/${player.pid}`, changed)}
      done={() => t('texturesChanged', { name: player.name })}
    >
      <Field label={t('skinLabel')} name="skin">
        <Input value={skin} onValueChange={setSkin} inputMode="numeric" maxLength={10} autoComplete="off" />
      </Field>
      <TexturePreview input={skin} owner={player.owner.uid} slot="skin" />
      <Field label={t('capeLabel')} name="cape">
        <Input value={cape} onValueChange={setCape} inputMode="numeric" maxLength={10} autoComplete="off" />
      </Field>
      <TexturePreview input={cape} owner={player.owner.uid} slot="cape" />
    </ActionDialog>
  )
}

interface Recipient {
  user: AdminUserLookup
  /** 新主人看不到、转让时会清掉的材质；查询失败的槽也按"会清掉"列出编号 */
  cleared: { slot: 'skin' | 'cape'; tid: number; name: string | null }[]
}

/**
 * 转让（ADR-0036"转让"）：先按 uid 或邮箱查到新主人（按邮箱查要有 users.ban），确认框显示新主人的头像、昵称、邮箱和身份，
 * 以及后果。要清掉的材质由角色现在的皮肤和披风各查一次 visibleToOwner 得出
 */
function TransferDialog({ player, emailLookup, mailConfigured, onOpenChange }: DialogProps & { emailLookup: boolean }) {
  const t = useTranslations('admin.players')
  const admin = useTranslations('admin')
  const format = useFormatter()
  const [query, setQuery] = useState('')
  const [lookup, setLookup] = useState<Lookup<Recipient> | { state: 'same' }>({ state: 'idle' })
  // 每次查找和每次改输入都换一个编号，只有最新一次查找的结果能写回：不然先查的人晚返回，确认的就成了输入框里没有的人
  const latest = useRef(0)

  async function find() {
    const q = query.trim()
    if (!q) return
    const request = ++latest.current
    const settle = (next: Lookup<Recipient> | { state: 'same' }) => {
      if (latest.current === request) setLookup(next)
    }
    setLookup({ state: 'loading' })
    const { status, data } = await getJson(`/api/admin/users/lookup?q=${encodeURIComponent(q)}`)
    if (status !== 200) {
      settle({ state: status === 404 ? 'missing' : 'failed' })
      return
    }
    const user = data as AdminUserLookup
    if (user.uid === player.owner.uid) {
      settle({ state: 'same' })
      return
    }
    const slots = [
      ...(player.skin ? [{ slot: 'skin' as const, tid: player.skin.tid }] : []),
      ...(player.cape ? [{ slot: 'cape' as const, tid: player.cape.tid }] : []),
    ]
    const checks = await Promise.all(
      slots.map(async ({ slot, tid }) => {
        const response = await getJson(`/api/admin/textures/${tid}?owner=${user.uid}`)
        const texture = response.status === 200 ? (response.data as AdminTextureForOwner) : null
        return texture?.visibleToOwner ? null : { slot, tid, name: texture && 'name' in texture ? texture.name : null }
      }),
    )
    settle({ state: 'found', value: { user, cleared: checks.filter((item) => item !== null) } })
  }

  const recipient = lookup.state === 'found' ? lookup.value : null
  return (
    <ActionDialog
      id={`admin-player-transfer-${player.pid}`}
      open
      danger
      onOpenChange={onOpenChange}
      title={t('transferTitle', { name: player.name })}
      description={t('transferHint')}
      confirm={t('transferConfirm')}
      confirmDisabled={!recipient}
      send={() => sendJson('POST', `/api/admin/players/${player.pid}/transfer`, { uid: recipient?.user.uid })}
      done={() => t('transferred', { name: player.name, nickname: recipient?.user.nickname ?? '' })}
    >
      <Field label={emailLookup ? t('recipientLabel') : t('recipientLabelUid')} name="recipient">
        <span className="flex gap-2">
          <Input
            value={query}
            onValueChange={(value) => {
              latest.current++
              setQuery(value)
              setLookup({ state: 'idle' })
            }}
            onKeyDown={(event) => {
              // 回车查找，不提交转让
              if (event.key === 'Enter') {
                event.preventDefault()
                void find()
              }
            }}
            inputMode={emailLookup ? 'email' : 'numeric'}
            maxLength={255}
            autoComplete="off"
            spellCheck={false}
          />
          <Button size="sm" onClick={() => void find()} loading={lookup.state === 'loading'}>
            {t('lookup')}
          </Button>
        </span>
      </Field>
      {lookup.state === 'missing' && <Alert tone="danger">{t('recipientNotFound')}</Alert>}
      {lookup.state === 'failed' && <Alert tone="danger">{admin('failed')}</Alert>}
      {lookup.state === 'same' && <Alert tone="info">{t('recipientSame')}</Alert>}
      {recipient && (
        <>
          <RecipientCard user={recipient.user} />
          <div className="flex flex-col gap-2 text-sm text-pretty text-text">
            <p className="font-medium">{t('consequencesTitle')}</p>
            <ul className="flex list-disc flex-col gap-1 pl-5">
              <li>{t('scoreNotRefunded', { score: player.scorePaid })}</li>
              {recipient.cleared.length > 0 && (
                <li>
                  {t('texturesCleared', {
                    items: format.list(
                      recipient.cleared.map((item) =>
                        item.name === null
                          ? t('clearedItem', { slot: item.slot, tid: item.tid })
                          : t('clearedItemNamed', { slot: item.slot, name: item.name }),
                      ),
                    ),
                  })}
                </li>
              )}
              <li>{t('launcherSignOut')}</li>
              {recipient.user.role === 'banned' && <li>{t('recipientBanned')}</li>}
              {mailConfigured && <li>{t('notify')}</li>}
            </ul>
          </div>
          <Alert tone="warning">{t('irreversible')}</Alert>
        </>
      )}
    </ActionDialog>
  )
}

/** 查到的新主人：头像、昵称、邮箱和身份，核对清楚再转让 */
function RecipientCard({ user }: { user: AdminUserLookup }) {
  const admin = useTranslations('admin')
  const role: UserRole = user.role
  return (
    <div className="flex items-center gap-3 rounded-md border border-border bg-surface-sunken p-3">
      <PlayerHead src={user.avatar ? headSrc(user.avatar.hash) : undefined} size={48} alt="" />
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 font-medium break-all text-text">{user.nickname}</span>
          <Badge tone={roleTones[role]}>{admin(`roles.${role}`)}</Badge>
        </span>
        <span className="text-sm break-all text-text-muted">
          UID <span className="font-mono">{user.uid}</span>
          {user.email !== null && <> · {user.email}</>}
        </span>
      </span>
    </div>
  )
}

/** 删除：不退积分；UUID 随角色一起失效，只是名字违规的话请改名（ADR-0036"删除"） */
function DeleteDialog({ player, mailConfigured, onOpenChange }: DialogProps) {
  const t = useTranslations('admin.players')
  return (
    <ActionDialog
      id={`admin-player-delete-${player.pid}`}
      open
      danger
      onOpenChange={onOpenChange}
      title={t('deleteTitle', { name: player.name })}
      description={t('deleteHint')}
      confirm={t('deleteConfirm')}
      send={() => sendJson('DELETE', `/api/admin/players/${player.pid}`)}
      done={() => t('deleted', { name: player.name })}
    >
      <p className="text-sm text-pretty text-text">{t('deleteRefund', { mail: mailConfigured ? 'yes' : 'no' })}</p>
    </ActionDialog>
  )
}
