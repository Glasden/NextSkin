import type { Core, PluginDetail, PluginSettingView } from '@nextskin/domain'
import { Alert, Badge, Link, Table } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getFormatter, getLocale, getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'
import { pluginDescription, pluginName, pluginTranslator } from '../../../../lib/plugins'
import { getServer } from '../../../../lib/server'
import { requireAdmin } from '../../../../lib/session'
import type { SettingItem, SettingText } from '../../settings/setting-text'
import { SettingsForm } from '../../settings/settings-form'
import { DeadLetterActions } from '../dead-letter-actions'
import { PluginStatus } from '../plugin-status'
import { PluginToggle } from '../plugin-toggle'

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const [{ id }, { core }, t, locale] = await Promise.all([
    params,
    getServer(),
    getTranslations('admin.plugins'),
    getLocale(),
  ])
  return { title: core.plugins.get(id) ? `${pluginName(core, id, locale)} · ${t('title')}` : t('title') }
}

const capabilities = [
  'users.read',
  'users.readPrivate',
  'players.read',
  'textures.read',
  'textures.readFile',
  'storage.kv',
  'storage.tables',
] as const

/** 插件设置项的文案按约定取（SDK 的 ui.ts）：`settings.<键>.label`，对象的属性、枚举的选项各有一层 */
function settingText(translate: ReturnType<typeof pluginTranslator>, view: PluginSettingView): SettingText {
  const optional = (key: string) => {
    const text = translate(key)
    return text === key ? undefined : text
  }
  const prefix = `settings.${view.key}`
  const label = optional(`${prefix}.label`) ?? view.key
  const control = view.control
  return {
    label,
    help: optional(`${prefix}.help`),
    options:
      control.kind === 'select'
        ? Object.fromEntries(
            control.options.map((option) => [option, optional(`${prefix}.options.${option}`) ?? option]),
          )
        : undefined,
    fields:
      control.kind === 'object'
        ? Object.fromEntries(
            control.properties.map(({ name }) => [
              name,
              {
                label: optional(`${prefix}.fields.${name}.label`) ?? name,
                help: optional(`${prefix}.fields.${name}.help`),
              },
            ]),
          )
        : undefined,
  }
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      <header className="flex flex-col gap-1">
        <h2 className="font-pixel text-pixel-1 text-text">{title}</h2>
        {description && <p className="max-w-3xl text-sm text-pretty text-text-muted">{description}</p>}
      </header>
      {children}
    </section>
  )
}

/** manifest 里的一项：一行标题、一串值；没有就写“无” */
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
    <div className="grid gap-1 py-3 sm:grid-cols-4 sm:gap-4">
      <dt className="text-sm text-text-muted">{label}</dt>
      <dd
        className={`flex min-w-0 gap-x-4 gap-y-1 text-sm text-text sm:col-span-3 ${stacked ? 'flex-col' : 'flex-wrap'}`}
      >
        {items.length ? items : <span className="text-text-muted">{none}</span>}
      </dd>
    </div>
  )
}

async function Manifest({ core, detail, locale }: { core: Core; detail: PluginDetail; locale: string }) {
  const t = await getTranslations('admin.plugins')
  const translate = pluginTranslator(core, detail.id, locale)
  const { manifest } = detail
  const code = (text: string) => (
    <code key={text} className="font-mono text-xs break-all">
      {text}
    </code>
  )
  const known = (value: string): value is (typeof capabilities)[number] =>
    (capabilities as readonly string[]).includes(value)
  return (
    <dl className="divide-y divide-border rounded-md border border-border bg-surface px-4 sm:px-6">
      <ManifestRow
        label={t('manifest.capabilities')}
        none={t('manifest.none')}
        items={manifest.capabilities.map((capability) => (
          <span key={capability} className="inline-flex items-center gap-2">
            {known(capability) ? t(`capabilities.${capability}`) : capability}
            {detail.highRisk.includes(capability) && <Badge tone="danger">{t('manifest.highRisk')}</Badge>}
          </span>
        ))}
      />
      <ManifestRow label={t('manifest.network')} none={t('manifest.none')} items={manifest.network.map(code)} />
      <ManifestRow label={t('manifest.events')} none={t('manifest.none')} items={manifest.events.map(code)} />
      <ManifestRow
        label={t('manifest.interceptors')}
        none={t('manifest.none')}
        items={manifest.interceptors.map(({ name }) => (
          <span key={name}>{name === 'user.register' ? t('interceptors.user.register') : name}</span>
        ))}
      />
      <ManifestRow
        label={t('manifest.formFields')}
        none={t('manifest.none')}
        items={(manifest.ui.formFields ?? []).map(({ field }) => (
          <span key={field.name}>{translate(field.label)}</span>
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
  )
}

/**
 * 一个插件（ADR-0033）：启用、停用，设置，失败的任务，以及它会做什么。只有超级管理员能进来（plugins.manage）
 */
export default async function AdminPluginPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await requireAdmin(`/admin/plugins/${id}`, 'plugins.manage')
  const [{ core }, t, format, locale] = await Promise.all([
    getServer(),
    getTranslations('admin.plugins'),
    getFormatter(),
    getLocale(),
  ])
  if (!core.plugins.get(id)) notFound()
  const actor = { uid: user.uid, ip: null }
  const [detail, settings, deadLetters] = await Promise.all([
    core.plugins.admin.detail(actor, id),
    core.plugins.admin.settings(actor, id),
    core.plugins.admin.deadLetters(actor, id),
  ])
  const name = pluginName(core, id, locale)
  const description = pluginDescription(core, id, locale)
  const translate = pluginTranslator(core, id, locale)
  const items: SettingItem[] = settings.map((view) => ({
    ...view,
    generate: false,
    text: settingText(translate, view),
    defaultValue: null,
  }))
  const highRisk = detail.highRisk.map((item) =>
    item === 'provider.passwordHasher'
      ? t('providers.passwordHasher')
      : item === 'provider.login'
        ? t('providers.login')
        : (capabilities as readonly string[]).includes(item)
          ? t(`capabilities.${item as (typeof capabilities)[number]}`)
          : item,
  )
  const prefix = `plugin:${id}:`

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <span className="text-sm">
          <Link render={<NextLink href="/admin/plugins" />}>{t('all')}</Link>
        </span>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-col gap-2">
            <h1 className="flex flex-wrap items-center gap-3 font-pixel text-pixel-2 text-text">
              {name}
              <span className="font-mono text-sm text-text-muted">{detail.version}</span>
            </h1>
            <div className="flex flex-wrap items-center gap-2">
              <PluginStatus plugin={detail} />
              {detail.official && <Badge>{t('official')}</Badge>}
              <code className="font-mono text-xs text-text-muted">{id}</code>
            </div>
            {description && <p className="max-w-3xl text-sm text-pretty text-text-muted">{description}</p>}
          </div>
          <PluginToggle id={id} name={name} enabled={detail.enabled} highRisk={highRisk} />
        </div>
      </header>

      {detail.enabled !== detail.running && <Alert tone="warning">{t('switchingHint')}</Alert>}
      {detail.lastError && (
        <Alert tone="danger" title={t('lastErrorTitle')}>
          <span className="font-mono text-xs break-all">{detail.lastError}</span>
        </Alert>
      )}

      <Section title={t('settings.title')}>
        {items.length ? (
          <div className="max-w-3xl">
            <SettingsForm
              items={items}
              label={t('settings.label', { name })}
              endpoint={`/api/admin/plugins/${id}/settings`}
            />
          </div>
        ) : (
          <p className="text-sm text-text-muted">{t('settings.empty')}</p>
        )}
      </Section>

      <Section title={t('deadLetters.title')} description={t('deadLetters.description')}>
        <Table<'job' | 'attempts' | 'failedAt' | 'error' | 'actions'>
          label={t('deadLetters.tableLabel')}
          empty={t('deadLetters.empty')}
          columns={[
            { key: 'job', header: t('deadLetters.columns.job') },
            { key: 'attempts', header: t('deadLetters.columns.attempts'), align: 'end', shrink: true },
            { key: 'failedAt', header: t('deadLetters.columns.failedAt'), shrink: true },
            { key: 'error', header: t('deadLetters.columns.error') },
            { key: 'actions', header: t('deadLetters.columns.actions'), shrink: true },
          ]}
          rows={deadLetters.map((job) => ({
            key: job.id,
            cells: {
              job: (
                <span className="flex flex-col">
                  <code className="font-mono text-xs">
                    {job.name.startsWith(prefix) ? job.name.slice(prefix.length) : job.name}
                  </code>
                  <span className="text-xs text-text-muted">#{job.id}</span>
                </span>
              ),
              attempts: format.number(job.attempts),
              failedAt: format.dateTime(new Date(job.failedAt), { dateStyle: 'short', timeStyle: 'short' }),
              error: job.lastError ? (
                <span className="block max-w-md font-mono text-xs break-all">{job.lastError}</span>
              ) : (
                <span className="text-text-muted">{t('deadLetters.noError')}</span>
              ),
              actions: <DeadLetterActions pluginId={id} jobId={job.id} />,
            },
          }))}
        />
      </Section>

      <Section title={t('manifest.title')}>
        <Manifest core={core} detail={detail} locale={locale} />
      </Section>
    </div>
  )
}
