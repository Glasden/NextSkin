'use client'

import type { PluginPackagePreview } from '@nextskin/domain'
import { Alert, Button, Dialog, DialogClose, FileDrop, useToast } from '@nextskin/ui'
import { createTranslator, useLocale, useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { apiError, postForm } from '../../../lib/api-client'
import { capabilityKey, ManifestList } from './manifest-list'

type State =
  | { stage: 'pick'; error?: string }
  | { stage: 'checking' }
  | { stage: 'confirm'; file: File; preview: PluginPackagePreview; error?: string }

/**
 * 插件包里的文案（还没装上，核心那边取不到）：先找当前语言，再找中文，都没有就显示键名。
 * 插件的语言和键都是运行时的字符串，不是核心的类型化文案
 */
function packageTranslator(messages: PluginPackagePreview['messages'], locale: string) {
  const translate = createTranslator as unknown as (options: {
    locale: string
    messages: Readonly<Record<string, unknown>>
    onError: () => void
  }) => { has(key: string): boolean; (key: string): string }
  const catalogs = [locale, 'zh-CN'].flatMap((name) =>
    messages[name] ? [translate({ locale: name, messages: messages[name], onError: () => {} })] : [],
  )
  return (key: string) => catalogs.find((t) => t.has(key))?.(key) ?? key
}

/**
 * 上传插件（ADR-0033"安装"）：选一个插件包，服务端检查之后列出它会做什么、要用的高风险能力、升级时新增的能力，
 * 管理员确认了再安装。确认时把同一个文件再传一次：多实例部署时两次请求可能落在不同的实例上，服务端不暂存
 */
export function PluginUpload({ networkRestricted }: { networkRestricted: boolean }) {
  const t = useTranslations('admin.plugins')
  const admin = useTranslations('admin')
  const common = useTranslations('common')
  const locale = useLocale()
  const router = useRouter()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<State>({ stage: 'pick' })
  const [pending, setPending] = useState(false)

  async function check(file: File) {
    setState({ stage: 'checking' })
    const body = new FormData()
    body.set('file', file)
    const { status, data } = await postForm('/api/admin/plugin-packages/preview', body)
    if (status === 200) setState({ stage: 'confirm', file, preview: data as PluginPackagePreview })
    else setState({ stage: 'pick', error: apiError(data)?.message ?? t('upload.failed') })
  }

  async function install(file: File, preview: PluginPackagePreview, name: string) {
    setPending(true)
    const body = new FormData()
    body.set('file', file)
    body.set('packageHash', preview.packageHash)
    const { status, data } = await postForm('/api/admin/plugin-packages', body)
    setPending(false)
    if (status !== 201) {
      setState({ stage: 'confirm', file, preview, error: apiError(data)?.message ?? admin('failed') })
      return
    }
    setOpen(false)
    const { id, version } = preview.manifest
    if (preview.action === 'install') {
      toast.show({ tone: 'success', title: t('upload.installedToast', { name }) })
      // 装上之后还没启用，去它的页面看看、启用
      router.push(`/admin/plugins/${id}`)
    } else {
      toast.show({ tone: 'success', title: t('upload.upgradedToast', { name, version }) })
      router.refresh()
    }
  }

  function close(next: boolean) {
    if (next) return
    setOpen(false)
    setState({ stage: 'pick' })
  }

  let dialog
  if (state.stage === 'confirm') {
    const { preview, file } = state
    const { manifest, previous } = preview
    const translate = packageTranslator(preview.messages, locale)
    const name = translate('plugin.name') === 'plugin.name' ? manifest.id : translate('plugin.name')
    const description = translate('plugin.description')
    const label = (item: string) => {
      const key = capabilityKey(item)
      return key ? t(key) : item
    }
    const added = previous && (previous.addedCapabilities.length > 0 || previous.addedNetwork.length > 0)
    dialog = (
      <Dialog
        open
        size="lg"
        onOpenChange={close}
        title={
          previous
            ? t('upload.upgradeTitle', { name, from: previous.version, to: manifest.version })
            : t('upload.installTitle', { name })
        }
        description={t('upload.trust')}
        actions={
          <>
            <DialogClose>{common('cancel')}</DialogClose>
            <Button variant="primary" loading={pending} onClick={() => void install(file, preview, name)}>
              {t(previous ? 'upload.confirmUpgrade' : 'upload.confirmInstall')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <code className="font-mono text-xs text-text-muted">{manifest.id}</code>
              <span className="font-mono text-xs text-text-muted">{manifest.version}</span>
            </p>
            {description !== 'plugin.description' && (
              <p className="text-sm text-pretty text-text-muted">{description}</p>
            )}
          </div>
          {state.error && <Alert tone="danger">{state.error}</Alert>}
          {preview.highRisk.length > 0 && (
            <p className="text-sm text-pretty text-danger">
              {t('upload.highRisk', { list: preview.highRisk.map(label).join('、') })}
            </p>
          )}
          {added && <Alert tone="warning">{t('upload.addedHint', { from: previous.version })}</Alert>}
          {!networkRestricted && <Alert tone="warning">{t('host.networkUnrestricted')}</Alert>}
          <ManifestList
            manifest={manifest}
            highRisk={preview.highRisk}
            translate={translate}
            added={previous ? { capabilities: previous.addedCapabilities, network: previous.addedNetwork } : undefined}
          />
          <p className="text-sm text-pretty text-text-muted">
            {previous
              ? t(previous.enabled ? 'upload.upgradeEnabled' : 'upload.upgradeDisabled')
              : t('upload.installHint')}
          </p>
        </div>
      </Dialog>
    )
  } else {
    dialog = (
      <Dialog
        open
        onOpenChange={close}
        title={t('upload.button')}
        actions={<DialogClose>{common('cancel')}</DialogClose>}
      >
        <FileDrop
          accept=".tgz,application/gzip"
          title={t('upload.drop')}
          description={state.stage === 'checking' ? t('upload.checking') : t('upload.dropHint')}
          buttonLabel={t('upload.label')}
          disabled={state.stage === 'checking'}
          error={state.stage === 'pick' ? state.error : undefined}
          onFile={(file) => void check(file)}
        />
      </Dialog>
    )
  }

  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        {t('upload.button')}
      </Button>
      {open && dialog}
    </>
  )
}
