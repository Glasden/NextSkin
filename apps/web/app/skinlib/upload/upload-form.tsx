'use client'

import {
  Alert,
  Button,
  Checkbox,
  Field,
  FileDrop,
  Form,
  Input,
  SegmentedControl,
  SkinFigure,
  Stage,
  Textarea,
  useToast,
} from '@nextskin/ui'
import type { Rgba, TextureType } from '@nextskin/skin'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { apiError, formErrors, postForm } from '../../../lib/api-client'
import {
  decodeLocalTexture,
  guessTextureType,
  isAmbiguous,
  renderLocalPreview,
  revokePreview,
  type LocalPreview,
} from '../../../lib/local-texture'

const NAME_MAX = 128
const DESCRIPTION_MAX = 2000

interface Selected {
  file: File
  image: Rgba
  ambiguous: boolean
}

export interface UploadFormProps {
  disabled: boolean
  score: number
  maxFileSizeKb: number
  nameRegex: string
  /** 每 KB 的存储费（公开、私有）和放进衣柜的费用（ADR-0025） */
  prices: { public: number; private: number; closetItem: number }
}

export function UploadForm({ disabled, score, maxFileSizeKb, nameRegex, prices }: UploadFormProps) {
  const t = useTranslations('skinlib.upload')
  const types = useTranslations('skinlib.types')
  const router = useRouter()
  const toast = useToast()
  const [selected, setSelected] = useState<Selected | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [type, setType] = useState<TextureType>('steve')
  const [isPublic, setPublic] = useState(true)
  const [name, setName] = useState('')
  const [preview, setPreview] = useState<LocalPreview | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const latest = useRef(0)

  // 换了文件或类型就重新出图；旧的 blob URL 用完即还
  useEffect(() => {
    if (!selected) return
    const run = ++latest.current
    let result: LocalPreview | null = null
    void renderLocalPreview(selected.image, type).then((next) => {
      if (run !== latest.current) return revokePreview(next)
      result = next
      setPreview(next)
    })
    return () => revokePreview(result)
  }, [selected, type])

  async function choose(file: File) {
    setError(null)
    setErrors({})
    if (file.size > maxFileSizeKb * 1024) {
      setFileError(t('tooLarge', { max: maxFileSizeKb }))
      return
    }
    const image = await decodeLocalTexture(file)
    if (!image) {
      setFileError(t('notPng'))
      return
    }
    const guess = guessTextureType(image)
    if (!guess) {
      setFileError(t('badSize', { width: image.width, height: image.height }))
      return
    }
    setFileError(null)
    setPreview(null)
    setSelected({ file, image, ambiguous: isAmbiguous(image) })
    setType(guess)
    setName(
      file.name
        .replace(/\.png$/i, '')
        .trim()
        .slice(0, NAME_MAX),
    )
  }

  async function submit(values: { name?: string; description?: string }) {
    if (!selected) return
    setPending(true)
    setError(null)
    setErrors({})
    const body = new FormData()
    body.set('file', selected.file)
    body.set('name', values.name ?? '')
    body.set('type', type)
    body.set('public', String(isPublic))
    if (values.description?.trim()) body.set('description', values.description)
    const { status, data } = await postForm('/api/textures', body)
    if (status === 201) {
      const { texture, charged } = data as { texture: { tid: number; name: string }; charged: number }
      toast.show({
        tone: 'success',
        title:
          charged > 0
            ? t('uploadedCharged', { name: texture.name, cost: charged })
            : t('uploaded', { name: texture.name }),
      })
      router.push(`/skinlib/${texture.tid}`)
      return
    }
    setPending(false)
    const failure = apiError(data)
    if (failure?.fields?.file) setFileError(failure.fields.file.message)
    else if (failure?.fields) setErrors(formErrors(failure))
    else setError(failure?.message ?? t('failed'))
  }

  // 按原文件估算：服务端按规范化之后的大小算，通常更小，所以写“最多”
  const sizeKb = selected ? Math.ceil(selected.file.size / 1024) : 0
  const cost = sizeKb * (isPublic ? prices.public : prices.private) + prices.closetItem
  const fits = preview !== null && preview.type === type

  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <section className="flex min-w-0 flex-col gap-3">
        {selected ? (
          <>
            <div className="h-80">
              <Stage grid>
                {fits ? (
                  <SkinFigure
                    src={(k) => preview.urls.get(k) ?? ''}
                    type={type}
                    textureScale={preview.textureScale}
                    scale={5}
                    alt={t('previewAlt', { type: types(type) })}
                    turnOnHover
                    loading="eager"
                  />
                ) : (
                  <p className="px-4 text-center text-sm text-text-muted">
                    {preview === null ? t('previewing') : t('typeMismatch', { type: types(type) })}
                  </p>
                )}
              </Stage>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-text-muted">
              <span className="min-w-0 truncate">
                {t('fileInfo', {
                  name: selected.file.name,
                  width: selected.image.width,
                  height: selected.image.height,
                  size: sizeKb,
                })}
              </span>
              <Button size="sm" onClick={() => setSelected(null)} disabled={pending}>
                {t('chooseAnother')}
              </Button>
            </div>
            {fileError && <Alert tone="danger">{fileError}</Alert>}
          </>
        ) : (
          <FileDrop
            accept="image/png"
            onFile={(file) => void choose(file)}
            title={t('dropTitle')}
            description={t('dropDescription', { max: maxFileSizeKb })}
            buttonLabel={t('chooseFile')}
            disabled={disabled}
            error={fileError}
          />
        )}
      </section>

      <section className="flex min-w-0 flex-col gap-4">
        <Form errors={errors} onFormSubmit={(values) => void submit(values)}>
          {error && <Alert tone="danger">{error}</Alert>}
          <Field
            label={t('name')}
            name="name"
            disabled={disabled}
            description={nameRegex ? t('nameHintRule', { max: NAME_MAX }) : t('nameHint', { max: NAME_MAX })}
          >
            <Input required maxLength={NAME_MAX} value={name} onValueChange={setName} />
          </Field>
          <Field
            label={t('type')}
            name="type"
            nativeLabel={false}
            disabled={disabled || !selected}
            description={selected?.ambiguous ? t('typeAmbiguous') : t('typeHint')}
          >
            <SegmentedControl
              fullWidth
              value={type}
              onValueChange={setType}
              options={[
                { value: 'steve', label: types('steve') },
                { value: 'alex', label: types('alex') },
                { value: 'cape', label: types('cape') },
              ]}
            />
          </Field>
          <Checkbox checked={isPublic} onCheckedChange={setPublic} disabled={disabled}>
            {t('public')}
          </Checkbox>
          <p className="-mt-2 text-sm text-pretty text-text-muted">
            {t('publicHint', { public: prices.public, private: prices.private })}
          </p>
          <Field label={t('description')} name="description" disabled={disabled} description={t('descriptionHint')}>
            <Textarea rows={4} maxLength={DESCRIPTION_MAX} />
          </Field>
          <div className="flex flex-col gap-3 border-t border-border pt-4">
            <p className="text-sm text-pretty text-text">
              {selected ? (cost > 0 ? t('cost', { cost, score }) : t('free')) : t('costUnknown', { score })}
            </p>
            {selected && cost > score && <Alert tone="warning">{t('mayBeInsufficient')}</Alert>}
            <div>
              <Button type="submit" variant="primary" size="lg" loading={pending} disabled={disabled || !fits}>
                {t('submit')}
              </Button>
            </div>
          </div>
        </Form>
      </section>
    </div>
  )
}
