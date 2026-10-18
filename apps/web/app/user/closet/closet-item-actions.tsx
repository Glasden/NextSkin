'use client'

import {
  Alert,
  Button,
  Dialog,
  DialogClose,
  Field,
  Form,
  IconButton,
  Input,
  Menu,
  MenuItem,
  MenuLinkItem,
  MenuSeparator,
  useToast,
} from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import NextLink from 'next/link'
import { useRouter } from 'next/navigation'
import { Human } from 'pixelarticons/react/Human.js'
import { Image } from 'pixelarticons/react/Image.js'
import { MoreVertical } from 'pixelarticons/react/MoreVertical.js'
import { Pencil } from 'pixelarticons/react/Pencil.js'
import { Trash } from 'pixelarticons/react/Trash.js'
import { User } from 'pixelarticons/react/User.js'
import { useState } from 'react'
import { apiError, formErrors, sendJson } from '../../../lib/api-client'
import { ApplyTextureDialog, type ApplyPlayer } from './apply-texture-dialog'

const NAME_MAX = 128

export interface ClosetEntry {
  tid: number
  name: string
  type: 'steve' | 'alex' | 'cape'
  /** 移出时退还的积分：开着 score.refundOnDelete 时是加入时实付的，否则是 0 */
  refund: number
}

/** 衣柜卡片右上角的“更多”：改名、换到角色上、设为头像、移出衣柜 */
export function ClosetItemActions({
  item,
  players,
  locked,
  nameRegex,
  isAvatar,
}: {
  item: ClosetEntry
  players: readonly ApplyPlayer[]
  locked: boolean
  nameRegex: string
  isAvatar: boolean
}) {
  const t = useTranslations('user.closet')
  const router = useRouter()
  const toast = useToast()
  const [dialog, setDialog] = useState<'rename' | 'apply' | 'remove' | null>(null)
  const close = (open: boolean) => {
    if (!open) setDialog(null)
  }

  async function setAvatar() {
    const { status, data } = await sendJson('PATCH', '/api/user', { avatar: item.tid })
    if (status === 200) toast.show({ tone: 'success', title: t('avatarSet', { name: item.name }) })
    else toast.show({ tone: 'danger', title: apiError(data)?.message ?? t('failed') })
    router.refresh()
  }

  return (
    <>
      <Menu
        align="end"
        trigger={
          <IconButton size="sm" label={t('more', { name: item.name })}>
            <MoreVertical />
          </IconButton>
        }
      >
        <MenuLinkItem render={<NextLink href={`/skinlib/${item.tid}`} />} icon={<Image aria-hidden />}>
          {t('viewDetail')}
        </MenuLinkItem>
        <MenuItem icon={<Pencil aria-hidden />} onClick={() => setDialog('rename')}>
          {t('rename')}
        </MenuItem>
        <MenuItem icon={<Human aria-hidden />} onClick={() => setDialog('apply')}>
          {item.type === 'cape' ? t('setCape') : t('setSkin')}
        </MenuItem>
        {item.type !== 'cape' && (
          <MenuItem icon={<User aria-hidden />} disabled={isAvatar} onClick={() => void setAvatar()}>
            {t('setAvatar')}
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem icon={<Trash aria-hidden />} onClick={() => setDialog('remove')}>
          {t('remove')}
        </MenuItem>
      </Menu>
      <RenameDialog item={item} nameRegex={nameRegex} open={dialog === 'rename'} onOpenChange={close} />
      <ApplyTextureDialog
        open={dialog === 'apply'}
        onOpenChange={close}
        texture={item}
        players={players}
        locked={locked}
      />
      <RemoveDialog
        item={item}
        players={players.filter((player) => player.skin === item.tid || player.cape === item.tid).length}
        open={dialog === 'remove'}
        onOpenChange={close}
      />
    </>
  )
}

function RenameDialog({
  item,
  nameRegex,
  open,
  onOpenChange,
}: {
  item: ClosetEntry
  nameRegex: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslations('user.closet')
  const common = useTranslations('common')
  const router = useRouter()
  const toast = useToast()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const formId = `rename-closet-${item.tid}`

  async function submit(values: { name?: string }) {
    if ((values.name ?? '').trim() === item.name) {
      onOpenChange(false)
      return
    }
    setPending(true)
    setError(null)
    setErrors({})
    const { status, data } = await sendJson('PATCH', `/api/closet/${item.tid}`, { name: values.name })
    setPending(false)
    if (status === 200) {
      toast.show({ tone: 'success', title: t('renamed', { name: (data as { name: string }).name }) })
      onOpenChange(false)
      router.refresh()
      return
    }
    const failure = apiError(data)
    if (failure?.fields) setErrors(formErrors(failure))
    else setError(failure?.message ?? t('failed'))
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) {
          setError(null)
          setErrors({})
        }
      }}
      title={t('renameTitle', { name: item.name })}
      description={t('renameHint')}
      actions={
        <>
          <DialogClose>{common('cancel')}</DialogClose>
          <Button type="submit" form={formId} variant="primary" loading={pending}>
            {t('rename')}
          </Button>
        </>
      }
    >
      <Form id={formId} errors={errors} onFormSubmit={(values) => void submit(values)}>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field
          label={t('name')}
          name="name"
          description={nameRegex ? t('nameHintRule', { max: NAME_MAX }) : t('nameHint', { max: NAME_MAX })}
        >
          <Input required maxLength={NAME_MAX} defaultValue={item.name} />
        </Field>
      </Form>
    </Dialog>
  )
}

function RemoveDialog({
  item,
  players,
  open,
  onOpenChange,
}: {
  item: ClosetEntry
  /** 自己有几个角色正在用它：移出时一起清掉 */
  players: number
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslations('user.closet')
  const common = useTranslations('common')
  const router = useRouter()
  const toast = useToast()
  const [pending, setPending] = useState(false)

  async function remove() {
    setPending(true)
    const { status, data } = await sendJson('DELETE', `/api/closet/${item.tid}`)
    setPending(false)
    onOpenChange(false)
    if (status === 200) {
      const { refunded } = data as { refunded: number }
      toast.show({
        tone: 'success',
        title:
          refunded > 0 ? t('removedRefund', { name: item.name, refund: refunded }) : t('removed', { name: item.name }),
      })
    } else {
      toast.show({ tone: 'danger', title: apiError(data)?.message ?? t('failed') })
    }
    router.refresh()
  }

  return (
    // 移出之后还能再加回来，不算不可逆：不用 alert 和 danger（DESIGN.md §6）
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('removeTitle', { name: item.name })}
      description={t('removeHint', { refund: item.refund, players })}
      actions={
        <>
          <DialogClose>{common('cancel')}</DialogClose>
          <Button variant="primary" loading={pending} onClick={() => void remove()}>
            {t('removeConfirm')}
          </Button>
        </>
      }
    />
  )
}
