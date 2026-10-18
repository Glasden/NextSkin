'use client'

import { Alert, Badge, Button, Dialog, DialogClose, Field, Form, Input, Link, Textarea, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import NextLink from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { apiError, formErrors, sendJson } from '../../../lib/api-client'
import { ApplyTextureDialog, type ApplyPlayer } from '../../user/closet/apply-texture-dialog'

const NAME_MAX = 128
const REASON_MAX = 500

export interface ViewerTexture {
  tid: number
  name: string
  type: 'steve' | 'alex' | 'cape'
}

/** 登录用户对材质的操作：加入或移出衣柜、换到角色上、设为头像（ADR-0026）。举报另见 ReportTexture */
export function TextureViewerActions({
  texture,
  closetItem,
  isAvatar,
  players,
  locked,
  score,
  closetCost,
  refund,
  nameRegex,
}: {
  texture: ViewerTexture
  /** 自己衣柜里的这一件 */
  closetItem: { name: string; scorePaid: number } | null
  isAvatar: boolean
  players: readonly ApplyPlayer[]
  /** 开着“必须验证邮箱”而还没验证：不能换到角色上 */
  locked: boolean
  score: number
  closetCost: number
  /** 开着 score.refundOnDelete */
  refund: boolean
  nameRegex: string
}) {
  const t = useTranslations('skinlib.actions')
  const router = useRouter()
  const toast = useToast()
  const [applying, setApplying] = useState(false)
  const [avatarPending, setAvatarPending] = useState(false)

  async function setAvatar() {
    setAvatarPending(true)
    const { status, data } = await sendJson('PATCH', '/api/user', { avatar: texture.tid })
    setAvatarPending(false)
    if (status === 200) toast.show({ tone: 'success', title: t('avatarSet') })
    else toast.show({ tone: 'danger', title: apiError(data)?.message ?? t('failed') })
    router.refresh()
  }

  return (
    <div className="flex flex-wrap gap-2">
      {closetItem ? (
        <RemoveFromClosetDialog texture={texture} refund={refund ? closetItem.scorePaid : 0} />
      ) : (
        <AddToClosetDialog texture={texture} cost={closetCost} score={score} nameRegex={nameRegex} />
      )}
      {closetItem && (
        <>
          <Button onClick={() => setApplying(true)}>{texture.type === 'cape' ? t('setCape') : t('setSkin')}</Button>
          <ApplyTextureDialog
            open={applying}
            onOpenChange={setApplying}
            texture={{ ...texture, name: closetItem.name }}
            players={players}
            locked={locked}
          />
        </>
      )}
      {texture.type !== 'cape' && (
        <Button disabled={isAvatar} loading={avatarPending} onClick={() => void setAvatar()}>
          {isAvatar ? t('isAvatar') : t('setAvatar')}
        </Button>
      )}
    </div>
  )
}

function AddToClosetDialog({
  texture,
  cost,
  score,
  nameRegex,
}: {
  texture: ViewerTexture
  cost: number
  score: number
  nameRegex: string
}) {
  const t = useTranslations('skinlib.actions')
  const common = useTranslations('common')
  const router = useRouter()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const formId = `add-closet-${texture.tid}`

  async function submit(values: { name?: string }) {
    setPending(true)
    setError(null)
    setErrors({})
    const name = (values.name ?? '').trim()
    const { status, data } = await sendJson('POST', '/api/closet', {
      tid: texture.tid,
      ...(name && name !== texture.name ? { name } : {}),
    })
    setPending(false)
    if (status === 201) {
      const paid = (data as { scorePaid: number }).scorePaid
      toast.show({ tone: 'success', title: paid > 0 ? t('addedCharged', { cost: paid }) : t('added') })
      setOpen(false)
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
        setOpen(next)
        if (next) {
          setError(null)
          setErrors({})
        }
      }}
      trigger={<Button variant="primary">{t('add')}</Button>}
      title={t('addTitle', { name: texture.name })}
      description={t('addCost', { cost, score })}
      actions={
        <>
          <DialogClose>{common('cancel')}</DialogClose>
          <Button type="submit" form={formId} variant="primary" loading={pending}>
            {t('add')}
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
          <Input required maxLength={NAME_MAX} defaultValue={texture.name} />
        </Field>
      </Form>
    </Dialog>
  )
}

function RemoveFromClosetDialog({ texture, refund }: { texture: ViewerTexture; refund: number }) {
  const t = useTranslations('skinlib.actions')
  const common = useTranslations('common')
  const router = useRouter()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)

  async function remove() {
    setPending(true)
    const { status, data } = await sendJson('DELETE', `/api/closet/${texture.tid}`)
    setPending(false)
    setOpen(false)
    if (status === 200) {
      const { refunded } = data as { refunded: number }
      toast.show({ tone: 'success', title: refunded > 0 ? t('removedRefund', { refund: refunded }) : t('removed') })
    } else {
      toast.show({ tone: 'danger', title: apiError(data)?.message ?? t('failed') })
    }
    router.refresh()
  }

  return (
    // 移出之后还能再加回来，不算不可逆：不用 alert 和 danger（DESIGN.md §6）
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={<Button>{t('remove')}</Button>}
      title={t('removeTitle', { name: texture.name })}
      description={t('removeHint', { refund })}
      actions={
        <>
          <DialogClose>{common('cancel')}</DialogClose>
          <Button variant="primary" loading={pending} onClick={() => void remove()}>
            {t('remove')}
          </Button>
        </>
      }
    />
  )
}

/** 举报：每个人对每个材质只能举报一次，举报过就只显示“已举报”（ADR-0026） */
export function ReportTexture({
  texture,
  reported,
  cost,
  reward,
}: {
  texture: ViewerTexture
  reported: boolean
  cost: number
  reward: number
}) {
  const t = useTranslations('skinlib.actions')
  const common = useTranslations('common')
  const router = useRouter()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const formId = `report-${texture.tid}`

  if (reported)
    return (
      <span className="flex items-center gap-2">
        <Badge>{t('reported')}</Badge>
        <Link render={<NextLink href="/user/reports" />}>{t('viewReports')}</Link>
      </span>
    )

  async function submit(values: { reason?: string }) {
    setPending(true)
    setError(null)
    setErrors({})
    const { status, data } = await sendJson('POST', '/api/reports', { tid: texture.tid, reason: values.reason ?? '' })
    setPending(false)
    if (status === 201) {
      toast.show({ tone: 'success', title: t('reportSent') })
      setOpen(false)
      router.refresh()
      return
    }
    const failure = apiError(data)
    if (failure?.fields) setErrors(formErrors(failure))
    else setError(failure?.message ?? t('failed'))
  }

  const policy = [t('reportCost', { cost }), t('reportReward', { reward })].filter(Boolean)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setError(null)
          setErrors({})
        }
      }}
      trigger={<Button size="sm">{t('report')}</Button>}
      title={t('reportTitle', { name: texture.name })}
      description={
        policy.length
          ? common('sentences', {
              first: t('reportDescription'),
              second: policy.length === 2 ? common('sentences', { first: policy[0]!, second: policy[1]! }) : policy[0]!,
            })
          : t('reportDescription')
      }
      actions={
        <>
          <DialogClose>{common('cancel')}</DialogClose>
          <Button type="submit" form={formId} variant="primary" loading={pending}>
            {t('reportConfirm')}
          </Button>
        </>
      }
    >
      <Form id={formId} errors={errors} onFormSubmit={(values) => void submit(values)}>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label={t('reason')} name="reason" description={t('reasonHint', { max: REASON_MAX })}>
          <Textarea required rows={5} maxLength={REASON_MAX} />
        </Field>
      </Form>
    </Dialog>
  )
}
