import { externalCallbackPath, type PluginSummary } from '@nextskin/domain'
import { Alert, Badge, cx, Link, Table } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getFormatter, getLocale, getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'
import { pluginSettingText } from '../../../../lib/plugin-settings'
import { pluginDescription, pluginName, pluginTranslator } from '../../../../lib/plugins'
import { getServer } from '../../../../lib/server'
import { getRequestRoot, requireAdmin } from '../../../../lib/session'
import type { SettingItem } from '../../settings/setting-text'
import { SettingsForm } from '../../settings/settings-form'
import { DeadLetterActions } from '../dead-letter-actions'
import { HostAlert, isHostDown } from '../host-alert'
import { capabilityKey, ManifestList } from '../manifest-list'
import { PluginStatus } from '../plugin-status'
import { PluginToggle } from '../plugin-toggle'
import { PluginUninstall } from '../plugin-uninstall'

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const [{ id }, { core }, t, locale] = await Promise.all([
    params,
    getServer(),
    getTranslations('admin.plugins'),
    getLocale(),
  ])
  return { title: core.plugins.get(id) ? `${pluginName(core, id, locale)} · ${t('title')}` : t('title') }
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

/** 回调地址经过的连接是加密的：https，或者本机调试用的 localhost（第三方也都接受它） */
function secureSite(siteUrl: string): boolean {
  const url = new URL(siteUrl)
  return url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
}

/** 本实例取不到包、也从来没取到过的安装插件：只有插件表里的 id 和版本，能做的只有停用和卸载 */
async function MissingPackage({ plugin }: { plugin: PluginSummary }) {
  const t = await getTranslations('admin.plugins')
  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <span className="text-sm">
          <Link render={<NextLink href="/admin/plugins" />}>{t('all')}</Link>
        </span>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-col gap-2">
            <h1 className="flex flex-wrap items-center gap-3 font-pixel text-pixel-2 text-text">
              {plugin.id}
              <span className="font-mono text-sm text-text-muted">{plugin.version}</span>
            </h1>
            <div className="flex flex-wrap items-center gap-2">
              <PluginStatus plugin={plugin} />
              <Badge>{t('installed')}</Badge>
            </div>
          </div>
          {plugin.enabled && <PluginToggle id={plugin.id} name={plugin.id} enabled highRisk={[]} />}
        </div>
      </header>
      <Alert tone="danger">{t('packageMissingHint')}</Alert>
      {plugin.lastError && (
        <Alert tone="danger" title={t('lastErrorTitle')}>
          <span className="font-mono text-xs break-all">{plugin.lastError}</span>
        </Alert>
      )}
      <Section title={t('uninstall.title')} description={t('uninstall.description')}>
        <div>
          <PluginUninstall id={plugin.id} name={plugin.id} />
        </div>
      </Section>
    </div>
  )
}

/**
 * 一个插件（ADR-0033）：启用、停用，设置，失败的任务，以及它会做什么。只有超级管理员能进来（plugins.manage）
 */
export default async function AdminPluginPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await requireAdmin(`/admin/plugins/${id}`, 'plugins.manage')
  const [{ core }, t, format, locale, root] = await Promise.all([
    getServer(),
    getTranslations('admin.plugins'),
    getFormatter(),
    getLocale(),
    getRequestRoot(),
  ])
  const actor = { uid: user.uid, ip: null }
  if (!core.plugins.get(id)) {
    // 本实例从来没取到过包的安装插件：不知道它会做什么，只能停用、卸载
    const summary = (await core.plugins.admin.list(actor)).find((item) => item.id === id && item.packageMissing)
    if (!summary) notFound()
    return <MissingPackage plugin={summary} />
  }
  const [detail, settings, deadLetters, host, site] = await Promise.all([
    core.plugins.admin.detail(actor, id),
    core.plugins.admin.settings(actor, id),
    core.plugins.admin.deadLetters(actor, id),
    core.plugins.admin.hostStatus(actor),
    core.settings.read(['site.url']),
  ])
  // 回调地址按站点地址拼，和发起登录时交给第三方的完全一致（packages/api 的 external-login.ts）
  const siteUrl = site['site.url'].replace(/\/+$/, '') || root
  const hostDown = !detail.official && isHostDown(host)
  const name = pluginName(core, id, locale)
  const description = pluginDescription(core, id, locale)
  const translate = pluginTranslator(core, id, locale)
  const items: SettingItem[] = settings.map((view) => ({
    ...view,
    generate: false,
    text: pluginSettingText(translate, view),
    defaultValue: null,
  }))
  const highRisk = detail.highRisk.map((item) => {
    const key = capabilityKey(item)
    return key ? t(key) : item
  })
  const prefix = `plugin:${id}:`
  const score = detail.score

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
              <PluginStatus plugin={detail} hostDown={hostDown} />
              <Badge>{t(detail.official ? 'official' : 'installed')}</Badge>
              <code className="font-mono text-xs text-text-muted">{id}</code>
            </div>
            {description && <p className="max-w-3xl text-sm text-pretty text-text-muted">{description}</p>}
          </div>
          <PluginToggle id={id} name={name} enabled={detail.enabled} highRisk={highRisk} />
        </div>
      </header>

      {!detail.official && <HostAlert status={host} />}
      {detail.packageMissing && <Alert tone="danger">{t('packageMissingHint')}</Alert>}
      {detail.enabled !== detail.running && !hostDown && !detail.packageMissing && (
        <Alert tone="warning">{t('switchingHint')}</Alert>
      )}
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

      {detail.logins.length > 0 && (
        <Section title={t('logins.title')} description={t('logins.description')}>
          <div className="flex max-w-3xl flex-col gap-3">
            {!secureSite(siteUrl) && <Alert tone="warning">{t('logins.notHttps')}</Alert>}
            <ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-surface">
              {detail.logins.map((login) => (
                <li key={login.providerId} className="flex flex-col gap-2 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-base text-text">{translate(login.label)}</span>
                    <Badge>{t('logins.bindings', { count: login.bindings })}</Badge>
                  </div>
                  <span className="text-xs text-text-muted">{t('logins.callback')}</span>
                  <code className="rounded-sm border border-border bg-surface-sunken px-3 py-2 font-mono text-sm break-all text-text select-all">
                    {siteUrl + externalCallbackPath(id, login.providerId)}
                  </code>
                </li>
              ))}
            </ul>
          </div>
        </Section>
      )}

      {score && (
        <Section title={t('score.title')} description={t('score.description')}>
          <div className="flex flex-col gap-4">
            <dl className="grid max-w-3xl grid-cols-2 gap-4">
              {(['added', 'deducted'] as const).map((kind) => (
                <div key={kind} className="flex flex-col gap-1 rounded-md border border-border bg-surface p-4">
                  <dt className="text-sm text-text-muted">{t(`score.${kind}`)}</dt>
                  <dd className="font-pixel text-pixel-2 text-text tabular-nums">{format.number(score[kind])}</dd>
                </div>
              ))}
            </dl>
            <div className="flex flex-col gap-2">
              <h3 className="text-sm text-text-muted">{t('score.recent')}</h3>
              <Table<'user' | 'reason' | 'delta' | 'balance' | 'createdAt'>
                label={t('score.tableLabel')}
                empty={t('score.empty')}
                columns={[
                  { key: 'user', header: t('score.columns.user') },
                  { key: 'reason', header: t('score.columns.reason') },
                  { key: 'delta', header: t('score.columns.delta'), align: 'end', shrink: true },
                  { key: 'balance', header: t('score.columns.balance'), align: 'end', shrink: true },
                  { key: 'createdAt', header: t('score.columns.createdAt'), shrink: true },
                ]}
                rows={score.recent.map((entry) => ({
                  key: entry.id,
                  cells: {
                    user: (
                      <span className="inline-flex flex-wrap items-baseline gap-2">
                        <Link render={<NextLink href={`/admin/users/${entry.uid}`} />}>{entry.nickname}</Link>
                        <span className="text-xs text-text-muted tabular-nums">#{entry.uid}</span>
                      </span>
                    ),
                    // 插件的文案键；插件升级后删掉了这个键时显示键名
                    reason: translate(entry.reason),
                    delta: (
                      <span className={cx('tabular-nums', entry.delta > 0 ? 'text-success' : 'text-text')}>
                        {`${entry.delta > 0 ? '+' : ''}${format.number(entry.delta)}`}
                      </span>
                    ),
                    balance: <span className="tabular-nums">{format.number(entry.balance)}</span>,
                    createdAt: format.dateTime(new Date(entry.createdAt), { dateStyle: 'short', timeStyle: 'short' }),
                  },
                }))}
              />
            </div>
          </div>
        </Section>
      )}

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
        <ManifestList manifest={detail.manifest} highRisk={detail.highRisk} translate={translate} />
      </Section>

      {!detail.official && (
        <Section title={t('uninstall.title')} description={t('uninstall.description')}>
          <div>
            <PluginUninstall
              id={id}
              name={name}
              bindings={detail.uninstallBindings}
              stranded={detail.strandedOnUninstall}
            />
          </div>
        </Section>
      )}
    </div>
  )
}
