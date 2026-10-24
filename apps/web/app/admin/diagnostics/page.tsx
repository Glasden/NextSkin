import type { DiagnosticsSummary } from '@nextskin/domain'
import { Alert, Badge, Link, Panel, cx } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getFormatter, getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import type { ReactNode } from 'react'
import { getServer } from '../../../lib/server'
import { requireAdmin } from '../../../lib/session'
import { HostAlert, isHostDown } from '../plugins/host-alert'
import { durationParts, LOW_SPACE_BYTES, LOW_SPACE_RATIO } from './diagnostics-text'
import { ExportButton } from './export-button'
import { LogViewer } from './log-viewer'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.diagnostics')
  return { title: t('title') }
}

const LOG_GUIDE = 'https://docs.nextskin.org/guide/faq/'

/**
 * 后台的诊断页（ADR-0062）：顶部是健康摘要，只读核心已经掌握的状态；下面是日志文件里的原样内容，
 * 停在第一页时每 5 秒取一次新的；页头导出脱敏的诊断包。只有超级管理员能进来（diagnostics.read）
 */
export default async function AdminDiagnosticsPage() {
  const user = await requireAdmin('/admin/diagnostics', 'diagnostics.read')
  const { core } = await getServer()
  const actor = { uid: user.uid, ip: null }
  const [summary, logs, t] = await Promise.all([
    core.diagnostics.summary(actor),
    core.diagnostics.logs(actor, {}),
    getTranslations('admin.diagnostics'),
  ])

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="font-pixel text-pixel-2 text-text">{t('title')}</h1>
          <p className="max-w-3xl text-sm text-pretty text-text-muted">{t('description')}</p>
        </div>
        <ExportButton />
      </header>

      <HostAlert status={summary.pluginHost} />

      <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        <VersionsCard summary={summary} />
        <DatabaseCard summary={summary} />
        <StorageCard summary={summary} />
        <PluginHostCard summary={summary} />
        <JobsCard summary={summary} />
        {summary.lastUpdate && <UpdateCard result={summary.lastUpdate} />}
      </div>

      <section aria-labelledby="diagnostics-logs" className="flex flex-col gap-3">
        <h2 id="diagnostics-logs" className="font-pixel text-pixel-1 text-text-muted">
          {t('logs.title')}
        </h2>
        {logs.available ? (
          <LogViewer initial={logs} />
        ) : (
          <Alert title={t('logs.unavailableTitle')}>
            <span className="flex flex-col gap-1">
              <span>
                {t(summary.storage.fileLogging ? 'logs.unavailableEmpty' : 'logs.unavailableOff', {
                  directory: `${summary.storage.dataDirectory}/logs`,
                })}
              </span>
              <span>
                <Link href={LOG_GUIDE} target="_blank" rel="noreferrer">
                  {t('logs.guide')}
                </Link>
              </span>
            </span>
          </Alert>
        )}
      </section>
    </div>
  )
}

/** 摘要的一块：像素字体的小标题，右上角是一句状态，下面是两列的事实 */
function Card({
  id,
  title,
  status,
  children,
  footer,
}: {
  id: string
  title: string
  status?: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <Panel as="section" padding="md" gap={4} aria-labelledby={`diagnostics-${id}`}>
      <div className="flex min-h-6 items-center justify-between gap-3">
        <h2 id={`diagnostics-${id}`} className="font-pixel text-pixel-1 text-text-muted">
          {title}
        </h2>
        {status}
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3">{children}</dl>
      {footer && <div className="border-t border-border pt-3 text-sm">{footer}</div>}
    </Panel>
  )
}

function Fact({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={cx('flex min-w-0 flex-col gap-0.5', wide && 'col-span-2')}>
      <dt className="text-sm text-text-muted">{label}</dt>
      <dd className="min-w-0 text-sm text-text">{children}</dd>
    </div>
  )
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs break-all">{children}</span>
}

/** 一段时长写成最大的两个单位：3 天 4 小时、5 小时 12 分钟、8 分钟 */
async function durationText() {
  const t = await getTranslations('admin.diagnostics.durations')
  return (milliseconds: number) => {
    const parts = durationParts(milliseconds)
    return 'days' in parts ? t('days', parts) : 'hours' in parts ? t('hours', parts) : t('minutes', parts)
  }
}

async function VersionsCard({ summary }: { summary: DiagnosticsSummary }) {
  const t = await getTranslations('admin.diagnostics.versions')
  const format = await getFormatter()
  const duration = await durationText()
  const { versions } = summary
  return (
    <Card id="versions" title={t('title')}>
      <Fact label={t('nextskin')}>
        {versions.nextskin ? (
          <span className="tabular-nums">{versions.nextskin}</span>
        ) : (
          <span className="text-text-muted">{t('source')}</span>
        )}
      </Fact>
      <Fact label={t('pluginApi')}>
        <span className="tabular-nums">{versions.pluginApi}</span>
      </Fact>
      <Fact label={t('node')}>
        <span className="tabular-nums">{versions.node}</span>
      </Fact>
      <Fact label={t('os')}>
        <span className="break-words">
          {versions.os} · {versions.arch}
        </span>
      </Fact>
      <Fact label={t('runMode')} wide>
        {t(`runModes.${summary.runMode}`)}
      </Fact>
      <Fact label={t('uptime')} wide>
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="tabular-nums">
            {duration(Date.parse(summary.generatedAt) - Date.parse(summary.startedAt))}
          </span>
          <time dateTime={summary.startedAt} className="text-xs text-text-muted">
            {t('startedAt', {
              time: format.dateTime(new Date(summary.startedAt), { dateStyle: 'medium', timeStyle: 'medium' }),
            })}
          </time>
        </span>
      </Fact>
    </Card>
  )
}

async function DatabaseCard({ summary }: { summary: DiagnosticsSummary }) {
  const t = await getTranslations('admin.diagnostics.database')
  const { database } = summary
  const pending = database.pendingCore + database.pendingPlugins.reduce((sum, item) => sum + item.migrations, 0)
  const status =
    database.unknownCore > 0 ? (
      <Badge tone="danger">{t('newer')}</Badge>
    ) : pending > 0 ? (
      <Badge tone="warning">{t('pending')}</Badge>
    ) : (
      <Badge tone="success">{t('upToDate')}</Badge>
    )
  return (
    <Card id="database" title={t('title')} status={status}>
      <Fact label={t('dialect')}>{t(`dialects.${database.dialect}`)}</Fact>
      <Fact label={t('serverVersion')}>
        {database.serverVersion ? (
          <span className="break-all tabular-nums">{database.serverVersion}</span>
        ) : (
          <span className="text-text-muted">{t('unknownVersion')}</span>
        )}
      </Fact>
      <Fact label={t('migrations')} wide>
        <span className="flex flex-col gap-0.5">
          {database.unknownCore > 0 && <span>{t('unknownCore', { count: database.unknownCore })}</span>}
          {database.pendingCore > 0 && <span>{t('pendingCore', { count: database.pendingCore })}</span>}
          {database.pendingPlugins.map((item) => (
            <span key={item.plugin}>
              {t.rich('pendingPlugin', {
                count: item.migrations,
                plugin: item.plugin,
                id: (chunks) => <Mono>{chunks}</Mono>,
              })}
            </span>
          ))}
          {database.unknownCore === 0 && pending === 0 && <span className="text-text-muted">{t('allApplied')}</span>}
        </span>
      </Fact>
    </Card>
  )
}

async function StorageCard({ summary }: { summary: DiagnosticsSummary }) {
  const t = await getTranslations('admin.diagnostics.storage')
  const format = await getFormatter()
  const { storage } = summary
  const size = (bytes: number) => {
    const [value, unit] =
      bytes >= 1024 ** 3
        ? [bytes / 1024 ** 3, 'gigabyte']
        : bytes >= 1024 ** 2
          ? [bytes / 1024 ** 2, 'megabyte']
          : bytes >= 1024
            ? [bytes / 1024, 'kilobyte']
            : [bytes, 'byte']
    return format.number(value, { style: 'unit', unit, maximumFractionDigits: 1 })
  }
  const lowSpace =
    storage.freeBytes !== null &&
    storage.totalBytes !== null &&
    (storage.freeBytes < LOW_SPACE_BYTES || storage.freeBytes < storage.totalBytes * LOW_SPACE_RATIO)
  const dropped = storage.droppedRecently !== null && storage.droppedRecently > 0
  const status = lowSpace ? (
    <Badge tone="warning">{t('lowSpace')}</Badge>
  ) : dropped ? (
    <Badge tone="warning">{t('droppedBadge')}</Badge>
  ) : null
  return (
    <Card id="storage" title={t('title')} status={status}>
      <Fact label={t('dataDirectory')} wide>
        <Mono>{storage.dataDirectory}</Mono>
      </Fact>
      <Fact label={t('free')}>
        {storage.freeBytes !== null && storage.totalBytes !== null ? (
          <span className="tabular-nums">
            {t('freeValue', { free: size(storage.freeBytes), total: size(storage.totalBytes) })}
          </span>
        ) : (
          <span className="text-text-muted">{t('unknown')}</span>
        )}
      </Fact>
      <Fact label={t('logs')}>
        {storage.fileLogging || storage.logFiles > 0 ? (
          <span className="tabular-nums">
            {t('logsValue', { size: size(storage.logBytes), count: storage.logFiles })}
          </span>
        ) : (
          <span className="text-text-muted">{t('logsOff')}</span>
        )}
      </Fact>
      {storage.droppedRecently !== null && (
        <Fact label={t('dropped')} wide>
          <span className={cx('tabular-nums', dropped && 'text-warning')}>
            {t(storage.droppedComplete ? 'droppedValue' : 'droppedAtLeast', { count: storage.droppedRecently })}
          </span>
        </Fact>
      )}
    </Card>
  )
}

const HOST_TONES = {
  running: 'success',
  idle: 'neutral',
  disabled: 'neutral',
  restarting: 'warning',
  failed: 'danger',
} as const

async function PluginHostCard({ summary }: { summary: DiagnosticsSummary }) {
  const t = await getTranslations('admin.diagnostics.pluginHost')
  const host = summary.pluginHost
  return (
    <Card
      id="plugin-host"
      title={t('title')}
      status={<Badge tone={HOST_TONES[host.state]}>{t(`states.${host.state}`)}</Badge>}
      footer={<Link render={<NextLink href="/admin/plugins" />}>{t('link')}</Link>}
    >
      <Fact label={t('plugins')} wide>
        {host.plugins.length > 0 ? (
          <span className="flex flex-wrap gap-x-3 gap-y-0.5">
            {host.plugins.map((plugin) => (
              <Mono key={plugin}>{plugin}</Mono>
            ))}
          </span>
        ) : (
          <span className="text-text-muted">{t(`empty.${host.state}`)}</span>
        )}
      </Fact>
      {host.lastError && !isHostDown(host) && (
        <Fact label={t('lastError')} wide>
          <Mono>{host.lastError}</Mono>
        </Fact>
      )}
      {host.enabled && (
        <Fact label={t('network')} wide>
          {host.networkRestricted ? t('networkRestricted') : t('networkUnrestricted')}
        </Fact>
      )}
    </Card>
  )
}

async function JobsCard({ summary }: { summary: DiagnosticsSummary }) {
  const t = await getTranslations('admin.diagnostics.jobs')
  const format = await getFormatter()
  const duration = await durationText()
  const { jobs } = summary
  return (
    <Card
      id="jobs"
      title={t('title')}
      status={jobs.deadLetters > 0 ? <Badge tone="warning">{t('failedBadge')}</Badge> : null}
      footer={<Link render={<NextLink href="/admin/failed-jobs" />}>{t('link')}</Link>}
    >
      <Fact label={t('queued')}>
        <span className="tabular-nums">{format.number(jobs.queued)}</span>
      </Fact>
      <Fact label={t('deadLetters')}>
        <span className={cx('tabular-nums', jobs.deadLetters > 0 && 'text-warning')}>
          {format.number(jobs.deadLetters)}
        </span>
      </Fact>
      <Fact label={t('oldest')} wide>
        {jobs.oldestDueAt ? (
          <span className="tabular-nums">
            {duration(Date.parse(summary.generatedAt) - Date.parse(jobs.oldestDueAt))}
          </span>
        ) : (
          <span className="text-text-muted">{t('nothingDue')}</span>
        )}
      </Fact>
    </Card>
  )
}

const RESULT_KEYS = { success: 'success', 'rolled-back': 'rolledBack', failed: 'failed' } as const

async function UpdateCard({ result }: { result: NonNullable<DiagnosticsSummary['lastUpdate']> }) {
  const t = await getTranslations('admin.diagnostics.update')
  const format = await getFormatter()
  const tone = result.result === 'success' ? 'success' : result.result === 'failed' ? 'danger' : 'warning'
  return (
    <Card
      id="update"
      title={t('title')}
      status={<Badge tone={tone}>{t(`results.${RESULT_KEYS[result.result]}`)}</Badge>}
      footer={<Link render={<NextLink href="/admin/updates" />}>{t('link')}</Link>}
    >
      <Fact label={t('kind')}>{t(`kinds.${result.kind}`)}</Fact>
      <Fact label={t('at')}>
        <time dateTime={result.at}>
          {format.dateTime(new Date(result.at), { dateStyle: 'medium', timeStyle: 'short' })}
        </time>
      </Fact>
      <Fact label={t('versions')} wide>
        <span className="tabular-nums">{t('versionsValue', { from: result.from ?? '—', to: result.to })}</span>
      </Fact>
      {result.reason && (
        <Fact label={t('reason')} wide>
          <span className="break-words">{result.reason}</span>
        </Fact>
      )}
    </Card>
  )
}
