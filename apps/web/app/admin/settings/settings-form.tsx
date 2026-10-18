'use client'

import type { SettingControl } from '@nextskin/domain'
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogClose,
  Field,
  Form,
  Input,
  Markdown,
  Select,
  Textarea,
  useToast,
} from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useId, useState } from 'react'
import { apiError, formErrors, sendJson } from '../../../lib/api-client'
import type { SettingItem, SettingText } from './setting-text'

/** 表单里的值：数字和多行列表先按输入的原文保存，提交时再转换 */
type Draft = string | boolean | { readonly [name: string]: Draft }
type Leaf = Exclude<SettingControl, { kind: 'object' | 'secret' }>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function toDraft(control: SettingControl, value: unknown): Draft {
  switch (control.kind) {
    case 'boolean':
      return value === true
    case 'number':
      return typeof value === 'number' ? String(value) : ''
    case 'lines':
      return Array.isArray(value) ? value.join('\n') : ''
    case 'object':
      return Object.fromEntries(
        control.properties.map(({ name, control }) => [
          name,
          toDraft(control, isRecord(value) ? value[name] : undefined),
        ]),
      )
    case 'secret':
      return ''
    default:
      return typeof value === 'string' ? value : ''
  }
}

function fromDraft(control: SettingControl, draft: Draft): unknown {
  switch (control.kind) {
    case 'number':
      return draft === '' ? null : Number(draft)
    case 'lines':
      return (typeof draft === 'string' ? draft : '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    case 'object':
      return Object.fromEntries(
        control.properties.map(({ name, control }) => [
          name,
          fromDraft(control, (isRecord(draft) ? draft[name] : undefined) ?? ''),
        ]),
      )
    default:
      return draft
  }
}

/**
 * 机密项填了就算改动；库里的值读不出来的，页面上显示的默认值本身就要写回去，也算改动；
 * 其余的按提交时的值比较，多行列表里多敲的空行不算
 */
function isChanged(item: SettingItem, draft: Draft, baseline: Draft): boolean {
  if (item.control.kind === 'secret') return draft !== ''
  if (item.unreadable) return true
  return JSON.stringify(fromDraft(item.control, draft)) !== JSON.stringify(fromDraft(item.control, baseline))
}

function initialDrafts(items: readonly SettingItem[]): Record<string, Draft> {
  return Object.fromEntries(items.map((item) => [item.key, toDraft(item.control, item.value)]))
}

/**
 * 一个分区的设置（ADR-0028）。只提交改过的项，同一次提交要么都生效、要么都不生效；
 * 服务端按设置项的键返回字段错误。机密项的“清除”和“生成”当场生效，不经过“保存”
 */
export function SettingsForm({
  items,
  label,
  endpoint = '/api/admin/settings',
}: {
  items: readonly SettingItem[]
  label: string
  /** 保存到哪里：核心的设置，或者某个插件的设置（`/api/admin/plugins/{id}/settings`） */
  endpoint?: string
}) {
  const t = useTranslations('admin.settings')
  const admin = useTranslations('admin')
  const router = useRouter()
  const toast = useToast()
  const [baseline, setBaseline] = useState(() => initialDrafts(items))
  const [drafts, setDrafts] = useState(baseline)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [failure, setFailure] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const changed = items.filter((item) => isChanged(item, drafts[item.key] ?? '', baseline[item.key] ?? ''))

  function update(key: string, draft: Draft) {
    setDrafts((current) => ({ ...current, [key]: draft }))
    setErrors((current) => {
      const next = { ...current }
      delete next[key]
      return next
    })
  }

  async function save() {
    if (!changed.length) {
      toast.show({ title: t('noChanges') })
      return
    }
    setPending(true)
    setFailure(null)
    const values = Object.fromEntries(changed.map((item) => [item.key, fromDraft(item.control, drafts[item.key]!)]))
    const { status, data } = await sendJson('PATCH', endpoint, { values })
    setPending(false)
    if (status === 200) {
      const count = isRecord(data) && Array.isArray(data.updated) ? data.updated.length : 0
      toast.show({ tone: 'success', title: count ? t('saved', { count }) : t('noChanges') })
      // 机密项保存以后清空输入框，旁边的“已设置”随刷新更新
      const saved = Object.fromEntries(
        items.map((item) => [item.key, item.control.kind === 'secret' ? '' : drafts[item.key]!]),
      )
      setBaseline(saved)
      setDrafts(saved)
      setErrors({})
      router.refresh()
      return
    }
    const error = apiError(data)
    if (error?.fields) {
      setErrors(formErrors(error))
      setFailure(t('invalid'))
    } else setFailure(error?.message ?? admin('failed'))
  }

  return (
    <Form aria-label={label} onFormSubmit={() => void save()}>
      <div className="rounded-md border border-border bg-surface">
        <div className="divide-y divide-border">
          {items.map((item) => (
            <div key={item.key} className="flex flex-col gap-3 px-4 py-5 sm:px-6">
              {item.unreadable && (
                <Alert tone="warning">{t('unreadable', { secret: String(item.control.kind === 'secret') })}</Alert>
              )}
              <Setting
                item={item}
                endpoint={endpoint}
                draft={drafts[item.key] ?? ''}
                error={errors[item.key]}
                onChange={(draft) => update(item.key, draft)}
              />
            </div>
          ))}
        </div>
        {/* 不做成粘在视口底部：会挡住下面几项获得焦点的输入框 */}
        <div className="flex flex-col gap-3 rounded-b-md border-t border-border bg-surface-sunken px-4 py-3 sm:flex-row sm:items-center sm:justify-end sm:px-6">
          {failure ? (
            <p role="alert" className="text-sm text-danger sm:mr-auto">
              {failure}
            </p>
          ) : (
            changed.length > 0 && (
              <p className="text-sm text-text-muted sm:mr-auto">{t('dirty', { count: changed.length })}</p>
            )
          )}
          <div>
            <Button type="submit" loading={pending}>
              {t('save')}
            </Button>
          </div>
        </div>
      </div>
    </Form>
  )
}

function Setting({
  item,
  endpoint,
  draft,
  error,
  onChange,
}: {
  item: SettingItem
  endpoint: string
  draft: Draft
  error: string | undefined
  onChange: (draft: Draft) => void
}) {
  const { control, text, key } = item
  if (control.kind === 'secret')
    return <SecretSetting item={item} endpoint={endpoint} draft={draft} error={error} onChange={onChange} />
  if (control.kind === 'markdown')
    return (
      <MarkdownSetting name={key} text={text} max={control.maxLength} draft={draft} error={error} onChange={onChange} />
    )
  if (control.kind === 'object') {
    const values = isRecord(draft) ? draft : {}
    return (
      <fieldset className="flex min-w-0 flex-col gap-3">
        <legend className="mb-3 text-sm font-medium text-text">{text.label}</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          {control.properties.map(({ name, control: property }) => (
            <LeafSetting
              key={name}
              name={`${key}.${name}`}
              control={property as Leaf}
              text={text.fields?.[name] ?? { label: name }}
              draft={values[name] ?? ''}
              onChange={(next) => onChange({ ...values, [name]: next })}
            />
          ))}
        </div>
        {text.help && <p className="text-sm text-pretty text-text-muted">{text.help}</p>}
        {error && <p className="text-sm text-danger">{error}</p>}
      </fieldset>
    )
  }
  return <LeafSetting name={key} control={control} text={text} draft={draft} error={error} onChange={onChange} />
}

/** 一个基本控件：开关、数字、文本、选择、一行一项的列表 */
function LeafSetting({
  name,
  control,
  text,
  draft,
  error,
  onChange,
}: {
  name: string
  control: Leaf
  text: SettingText
  draft: Draft
  /** 对象的属性没有：对象的错误整体显示在对象下方 */
  error?: string
  onChange: (draft: Draft) => void
}) {
  const helpId = useId()
  const value = typeof draft === 'string' ? draft : ''
  switch (control.kind) {
    case 'boolean':
      return (
        <div className="flex flex-col gap-1">
          <Checkbox
            checked={draft === true}
            onCheckedChange={(checked) => onChange(checked)}
            aria-describedby={text.help ? helpId : undefined}
          >
            {text.label}
          </Checkbox>
          {text.help && (
            <p id={helpId} className="pl-8 text-sm text-pretty text-text-muted">
              {text.help}
            </p>
          )}
          {error && <p className="pl-8 text-sm text-danger">{error}</p>}
        </div>
      )
    case 'number':
      return (
        <Field label={text.label} name={name} description={text.help} error={error}>
          <div className="max-w-48">
            <Input
              type="number"
              inputMode="numeric"
              required
              min={control.min ?? undefined}
              max={control.max ?? undefined}
              step={control.integer ? 1 : 'any'}
              value={value}
              onValueChange={(next) => onChange(next)}
            />
          </div>
        </Field>
      )
    case 'select':
      return (
        <Field label={text.label} name={name} nativeLabel={false} description={text.help} error={error}>
          <div className="max-w-sm">
            <Select
              options={control.options.map((option) => ({ value: option, label: text.options?.[option] ?? option }))}
              value={value}
              onValueChange={(next) => onChange(next)}
            />
          </div>
        </Field>
      )
    case 'lines':
      return (
        <Field label={text.label} name={name} description={text.help} error={error}>
          <Textarea
            rows={Math.min(Math.max(value.split('\n').length + 1, 3), 8)}
            value={value}
            onValueChange={(next) => onChange(next)}
          />
        </Field>
      )
    case 'text':
      return (
        <Field label={text.label} name={name} description={text.help} error={error}>
          <Input
            type={control.format ?? 'text'}
            required={control.required}
            maxLength={control.maxLength ?? undefined}
            spellCheck={control.format ? false : undefined}
            value={value}
            onValueChange={(next) => onChange(next)}
          />
        </Field>
      )
    default:
      return null
  }
}

/** 公告、内容政策这类长文：写 Markdown，可以展开预览，预览和用户看到的是同一个组件 */
function MarkdownSetting({
  name,
  text,
  max,
  draft,
  error,
  onChange,
}: {
  name: string
  text: SettingText
  max: number | null
  draft: Draft
  error?: string
  onChange: (draft: Draft) => void
}) {
  const t = useTranslations('admin.settings.markdown')
  const common = useTranslations('common')
  const [preview, setPreview] = useState(false)
  const value = typeof draft === 'string' ? draft : ''
  const hint = t('hint', { max: max ?? 0 })
  return (
    <div className="flex flex-col gap-3">
      <Field
        label={text.label}
        name={name}
        description={text.help ? common('sentences', { first: text.help, second: hint }) : hint}
        error={error}
      >
        <Textarea rows={8} maxLength={max ?? undefined} value={value} onValueChange={(next) => onChange(next)} />
      </Field>
      <div>
        {/* 一个分区里可能有几个 Markdown 设置（公告、页脚文字），按钮的名字带上设置项，读屏软件分得清；看得见的字放在名字开头 */}
        <Button
          size="sm"
          variant="secondary"
          aria-expanded={preview}
          aria-label={t('buttonLabel', { action: preview ? t('hidePreview') : t('preview'), label: text.label })}
          onClick={() => setPreview(!preview)}
        >
          {preview ? t('hidePreview') : t('preview')}
        </Button>
      </div>
      {preview && (
        <section
          aria-label={t('previewLabel', { label: text.label })}
          className="rounded-md border border-border bg-bg p-4"
        >
          {value.trim() ? (
            // 设置页只有 h1，预览里的 `#` 从 h2 开始
            <Markdown headingLevel={1}>{value}</Markdown>
          ) : (
            <p className="text-sm text-text-muted">{t('empty')}</p>
          )}
        </section>
      )}
    </div>
  )
}

/**
 * 机密项：只显示设没设过，输入框留空表示不改（ADR-0028）。“清除”恢复成默认值，
 * 声明了 generate 的（签名私钥）可以让服务端生成；已经有值时先确认后果
 */
function SecretSetting({
  item,
  endpoint,
  draft,
  error,
  onChange,
}: {
  item: SettingItem
  endpoint: string
  draft: Draft
  error?: string
  onChange: (draft: Draft) => void
}) {
  const t = useTranslations('admin.settings')
  const admin = useTranslations('admin')
  const common = useTranslations('common')
  const router = useRouter()
  const toast = useToast()
  const [dialog, setDialog] = useState<'clear' | 'generate' | null>(null)
  const [pending, setPending] = useState<'clear' | 'generate' | null>(null)
  const { key, text, control } = item
  const value = typeof draft === 'string' ? draft : ''
  const multiline = control.kind === 'secret' && control.multiline

  async function run(action: 'clear' | 'generate') {
    setPending(action)
    const { status, data } =
      action === 'clear'
        ? await sendJson('PATCH', endpoint, { values: { [key]: item.defaultValue } })
        : await sendJson('POST', `/api/admin/settings/${encodeURIComponent(key)}/generate`)
    setPending(null)
    setDialog(null)
    if (status === 200) {
      toast.show({
        tone: 'success',
        title:
          action === 'clear' ? t('secret.cleared', { label: text.label }) : t('generate.done', { label: text.label }),
      })
      router.refresh()
    } else toast.show({ tone: 'danger', title: apiError(data)?.message ?? admin('failed') })
  }

  const label = (
    <span className="inline-flex flex-wrap items-center gap-2">
      {text.label}
      <Badge tone={item.isSet ? 'success' : 'neutral'}>{item.isSet ? t('secret.set') : t('secret.unset')}</Badge>
    </span>
  )
  return (
    <div className="flex flex-col gap-3">
      <Field label={label} name={key} description={text.help} error={error}>
        {multiline ? (
          <Textarea
            rows={4}
            placeholder={t('secret.placeholder')}
            value={value}
            onValueChange={(next) => onChange(next)}
          />
        ) : (
          <Input
            type="password"
            autoComplete="new-password"
            placeholder={t('secret.placeholder')}
            value={value}
            onValueChange={(next) => onChange(next)}
          />
        )}
      </Field>
      {(item.generate || item.isSet || item.unreadable) && (
        <div className="flex flex-wrap gap-2">
          {item.generate && (
            <Button
              size="sm"
              variant="secondary"
              loading={pending === 'generate'}
              onClick={() => (item.isSet ? setDialog('generate') : void run('generate'))}
            >
              {t('generate.button')}
            </Button>
          )}
          {(item.isSet || item.unreadable) && (
            <Button size="sm" variant="secondary" onClick={() => setDialog('clear')}>
              {t('secret.clear')}
            </Button>
          )}
        </div>
      )}
      {dialog && (
        <Dialog
          alert
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null)
          }}
          title={
            dialog === 'clear'
              ? t('secret.clearTitle', { label: text.label })
              : t('generate.title', { label: text.label })
          }
          description={dialog === 'clear' ? t('secret.clearHint') : text.generateHint}
          actions={
            <>
              <DialogClose>{common('cancel')}</DialogClose>
              <Button variant="danger" loading={pending === dialog} onClick={() => void run(dialog)}>
                {dialog === 'clear' ? t('secret.clear') : t('generate.confirm')}
              </Button>
            </>
          }
        />
      )}
    </div>
  )
}
