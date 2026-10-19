'use client'

import {
  Alert,
  Button,
  Dialog,
  DialogClose,
  Field,
  Form,
  Input,
  SegmentedControl,
  Textarea,
  useToast,
} from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { apiError, formErrors, sendJson } from '../../../lib/api-client'

export interface OwnerTexture {
  tid: number
  name: string
  type: 'steve' | 'alex' | 'cape'
  public: boolean
  description: string | null
  /** 宽等于高：只有新格式的皮肤能用纤细（Alex）模型 */
  square: boolean
}

export interface OwnerManagement {
  /** 切换公开状态按现价要多扣（正）或退还（负）的积分（ADR-0025 的多退少补） */
  visibilityDelta: number
  /** 现在删除退给上传者的积分 */
  deleteRefund: number
  /** 别人的衣柜里有几件：改私有、删除时会被移除 */
  othersInCloset: number
}

const DESCRIPTION_MAX = 2000
const NAME_MAX = 128

/** 上传者自己的操作：编辑（名字、模型、描述）、改公开状态、删除。都在确认框里写明后果（DESIGN.md §7） */
export function TextureOwnerActions({
  texture,
  management,
  nameRegex,
}: {
  texture: OwnerTexture
  management: OwnerManagement
  nameRegex: string
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <EditTextureDialog texture={texture} nameRegex={nameRegex} endpoint={`/api/textures/${texture.tid}`} />
      <VisibilityDialog texture={texture} management={management} />
      <DeleteTextureDialog texture={texture} management={management} />
    </div>
  )
}

/**
 * 编辑名字、模型和描述，只提交改了的项。上传者走 `/api/textures/{tid}`，有 textures.manage 的人改别人的材质走
 * `/api/admin/textures/{tid}`（ADR-0036"别人的材质"），规则相同
 */
export function EditTextureDialog({
  texture,
  nameRegex,
  endpoint,
}: {
  texture: Pick<OwnerTexture, 'tid' | 'name' | 'type' | 'description' | 'square'>
  nameRegex: string
  endpoint: string
}) {
  const t = useTranslations('skinlib.manage')
  const types = useTranslations('skinlib.types')
  const common = useTranslations('common')
  const router = useRouter()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const formId = `edit-texture-${texture.tid}`
  // 只有新格式的皮肤能在两种模型之间切换；披风和旧版 64×32 皮肤不显示这一项
  const modelEditable = texture.type !== 'cape' && texture.square

  async function submit(values: { name?: string; type?: string; description?: string }) {
    const body: Record<string, string | null> = {}
    if (values.name !== undefined && values.name.trim() !== texture.name) body.name = values.name
    if (modelEditable && values.type && values.type !== texture.type) body.type = values.type
    const description = (values.description ?? '').trim()
    if (description !== (texture.description ?? '')) body.description = description || null
    if (!Object.keys(body).length) {
      setOpen(false)
      return
    }
    setPending(true)
    setError(null)
    setErrors({})
    const { status, data } = await sendJson('PATCH', endpoint, body)
    setPending(false)
    if (status === 200) {
      toast.show({ tone: 'success', title: t('saved') })
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
      trigger={<Button size="sm">{t('edit')}</Button>}
      title={t('editTitle')}
      actions={
        <>
          <DialogClose>{common('cancel')}</DialogClose>
          <Button type="submit" form={formId} variant="primary" loading={pending}>
            {t('save')}
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
        {modelEditable && (
          <Field label={t('model')} name="type" nativeLabel={false} description={t('modelHint')}>
            <SegmentedControl
              fullWidth
              defaultValue={texture.type}
              options={[
                { value: 'steve', label: types('steve') },
                { value: 'alex', label: types('alex') },
              ]}
            />
          </Field>
        )}
        <Field label={t('description')} name="description" description={t('descriptionHint')}>
          <Textarea rows={5} maxLength={DESCRIPTION_MAX} defaultValue={texture.description ?? ''} />
        </Field>
      </Form>
    </Dialog>
  )
}

function VisibilityDialog({ texture, management }: { texture: OwnerTexture; management: OwnerManagement }) {
  const t = useTranslations('skinlib.manage')
  const common = useTranslations('common')
  const router = useRouter()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const toPublic = !texture.public
  const delta = management.visibilityDelta

  async function apply() {
    setPending(true)
    const { status, data } = await sendJson('PATCH', `/api/textures/${texture.tid}`, { public: toPublic })
    setPending(false)
    setOpen(false)
    if (status === 200) {
      const { scoreDelta } = data as { scoreDelta: number }
      toast.show({
        tone: 'success',
        title: toPublic
          ? t('madePublic', { refund: Math.max(0, scoreDelta) })
          : t('madePrivate', { cost: Math.max(0, -scoreDelta) }),
      })
    } else {
      toast.show({ tone: 'danger', title: apiError(data)?.message ?? t('failed') })
    }
    router.refresh()
  }

  const description = toPublic
    ? t('makePublicHint', { change: delta < 0 ? 'refund' : delta > 0 ? 'cost' : 'none', amount: Math.abs(delta) })
    : t('makePrivateHint', {
        change: delta > 0 ? 'cost' : delta < 0 ? 'refund' : 'none',
        amount: Math.abs(delta),
        closets: management.othersInCloset,
      })

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={<Button size="sm">{toPublic ? t('makePublic') : t('makePrivate')}</Button>}
      title={toPublic ? t('makePublicTitle', { name: texture.name }) : t('makePrivateTitle', { name: texture.name })}
      description={description}
      actions={
        <>
          <DialogClose>{common('cancel')}</DialogClose>
          <Button variant="primary" loading={pending} onClick={() => void apply()}>
            {toPublic ? t('makePublic') : t('makePrivate')}
          </Button>
        </>
      }
    />
  )
}

function DeleteTextureDialog({ texture, management }: { texture: OwnerTexture; management: OwnerManagement }) {
  const t = useTranslations('skinlib.manage')
  const common = useTranslations('common')
  const router = useRouter()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)

  async function remove() {
    setPending(true)
    const { status, data } = await sendJson('DELETE', `/api/textures/${texture.tid}`)
    setPending(false)
    setOpen(false)
    if (status === 200) {
      const { refunded } = data as { refunded: number }
      toast.show({
        tone: 'success',
        title:
          refunded > 0
            ? t('deletedRefund', { name: texture.name, refund: refunded })
            : t('deleted', { name: texture.name }),
      })
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
      description={t('deleteHint', { refund: management.deleteRefund, closets: management.othersInCloset })}
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
