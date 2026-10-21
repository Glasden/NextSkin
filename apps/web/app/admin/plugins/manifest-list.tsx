import type { PluginDetail } from '@nextskin/domain'
import { Badge } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import type { ReactNode } from 'react'

// 插件详情页（服务端）和上传插件的确认框（客户端）共用：不写 'use client'，也不碰服务端的东西

const capabilities = [
  'users.read',
  'users.readPrivate',
  'users.score',
  'players.read',
  'textures.read',
  'textures.readFile',
  'storage.kv',
  'storage.tables',
] as const

/** 能力和高风险项的文案键；认不出来的（更新的 SDK 加的能力）返回 null，调用方原样显示 */
export function capabilityKey(
  item: string,
): `capabilities.${(typeof capabilities)[number]}` | 'providers.passwordHasher' | 'providers.login' | null {
  if (item === 'provider.passwordHasher') return 'providers.passwordHasher'
  if (item === 'provider.login') return 'providers.login'
  return (capabilities as readonly string[]).includes(item)
    ? `capabilities.${item as (typeof capabilities)[number]}`
    : null
}

/** manifest 里的一项：一行标题、一串值；没有就写“无”。容器窄的时候（确认框里）标题在上、值在下 */
function ManifestRow({
  label,
  items,
  none,
  stacked = false,
}: {
  label: string
  items: readonly ReactNode[]
  none: string
  /** 每项一行，例如接口：一行一条读起来比挤在一起清楚 */
  stacked?: boolean
}) {
  return (
    <div className="grid gap-1 py-3 @xl:grid-cols-4 @xl:gap-4">
      <dt className="text-sm text-text-muted">{label}</dt>
      <dd
        className={`flex min-w-0 gap-x-4 gap-y-1 text-sm text-text @xl:col-span-3 ${stacked ? 'flex-col' : 'flex-wrap'}`}
      >
        {items.length ? items : <span className="text-text-muted">{none}</span>}
      </dd>
    </div>
  )
}

/**
 * 插件会做什么（manifest，ADR-0033）。`translate` 取插件自己的文案（表单字段、页面标题）；
 * `added` 是升级时新版本多要的能力和外部地址，标上“新增”
 */
export function ManifestList({
  manifest,
  highRisk,
  translate,
  added,
}: {
  manifest: PluginDetail['manifest']
  highRisk: readonly string[]
  translate: (key: string) => string
  added?: { capabilities: readonly string[]; network: readonly string[] }
}) {
  const t = useTranslations('admin.plugins')
  const isNew = (list: readonly string[] | undefined, item: string) =>
    list?.includes(item) && <Badge tone="warning">{t('upload.added')}</Badge>
  const code = (text: string) => (
    <code key={text} className="font-mono text-xs break-all">
      {text}
    </code>
  )
  return (
    <div className="@container">
      <dl className="divide-y divide-border rounded-md border border-border bg-surface px-4 @xl:px-6">
        <ManifestRow
          label={t('manifest.capabilities')}
          none={t('manifest.none')}
          items={manifest.capabilities.map((capability) => {
            const key = capabilityKey(capability)
            return (
              <span key={capability} className="inline-flex flex-wrap items-center gap-2">
                {key ? t(key) : capability}
                {highRisk.includes(capability) && <Badge tone="danger">{t('manifest.highRisk')}</Badge>}
                {isNew(added?.capabilities, capability)}
              </span>
            )
          })}
        />
        <ManifestRow
          label={t('manifest.network')}
          none={t('manifest.none')}
          items={manifest.network.map((host) => (
            <span key={host} className="inline-flex flex-wrap items-center gap-2">
              {code(host)}
              {isNew(added?.network, host)}
            </span>
          ))}
        />
        <ManifestRow label={t('manifest.events')} none={t('manifest.none')} items={manifest.events.map(code)} />
        <ManifestRow
          label={t('manifest.interceptors')}
          none={t('manifest.none')}
          items={manifest.interceptors.map(({ name }) => (
            <span key={name}>{name === 'user.register' ? t('interceptors.user.register') : name}</span>
          ))}
        />
        <ManifestRow
          label={t('manifest.providers')}
          none={t('manifest.none')}
          stacked
          items={(['passwordHasher', 'login'] as const).flatMap((kind) =>
            manifest.providers[kind].map((provider) => (
              <span key={`${kind}:${provider.id}`} className="inline-flex flex-wrap items-center gap-2">
                {t('manifest.providerItem', { kind: t(`providers.${kind}`), label: translate(provider.label) })}
                {highRisk.includes(`provider.${kind}`) && <Badge tone="danger">{t('manifest.highRisk')}</Badge>}
              </span>
            )),
          )}
        />
        <ManifestRow
          label={t('manifest.formFields')}
          none={t('manifest.none')}
          items={(manifest.ui.formFields ?? []).map(({ field, fromQuery }) => (
            <span key={field.name} className="inline-flex flex-wrap items-baseline gap-2">
              {translate(field.label)}
              {fromQuery && <span className="text-xs text-text-muted">{t('manifest.fromQuery')}</span>}
            </span>
          ))}
        />
        <ManifestRow
          label={t('manifest.routes')}
          none={t('manifest.none')}
          stacked
          items={manifest.routes.map((route) => (
            <span key={`${route.method} ${route.path}`} className="inline-flex items-baseline gap-2">
              {code(`${route.method} /plugins/${manifest.id}${route.path === '/' ? '' : route.path}`)}
              <span className="text-xs text-text-muted">{t('manifest.routeAuth', { auth: route.auth })}</span>
            </span>
          ))}
        />
        <ManifestRow label={t('manifest.tables')} none={t('manifest.none')} items={manifest.tables.map(code)} />
        <ManifestRow
          label={t('manifest.jobs')}
          none={t('manifest.none')}
          items={manifest.jobs.map(({ name }) => code(name))}
        />
        <ManifestRow
          label={t('manifest.cron')}
          none={t('manifest.none')}
          items={manifest.cron.map(({ schedule, job }) => code(`${schedule} → ${job}`))}
        />
        <ManifestRow
          label={t('manifest.pages')}
          none={t('manifest.none')}
          items={Object.entries(manifest.ui.pages ?? {}).map(([key, page]) => (
            <span key={key}>{translate(page.title)}</span>
          ))}
        />
      </dl>
    </div>
  )
}
