import type { AdminFailedJob } from '@nextskin/domain'
import { Link, Pagination, Table } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getFormatter, getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { getServer } from '../../../lib/server'
import { requireAdmin } from '../../../lib/session'
import { ADMIN_PER_PAGE, failedJobsHref, parseFailedJobsPage } from '../params'
import { FailedJobActions, FailedJobsBulkActions } from './failed-job-actions'
import { jobKey, mailPayload, parseJobError } from './job-text'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.failedJobs')
  return { title: t('title') }
}

type Column = 'job' | 'time' | 'error' | 'actions'

/** 载荷是空对象、null 时不显示 JSON */
function hasContent(payload: unknown): boolean {
  return payload !== null && !(typeof payload === 'object' && Object.keys(payload).length === 0)
}

/**
 * 后台的失败任务页（ADR-0051）：核心任务的死信，最新的在前。邮件写模板和收件人，其余任务显示载荷；
 * 能重试的重试，全部重试只处理页面打开时已经有的。插件任务的死信在插件详情页
 */
export default async function AdminFailedJobsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const page = parseFailedJobsPage(await searchParams)
  const viewer = await requireAdmin(failedJobsHref(page), 'jobs.manage')
  const { core } = await getServer()
  const [{ items, total, latestId }, t, admin, format] = await Promise.all([
    core.admin.listFailedJobs(viewer.uid, { page, perPage: ADMIN_PER_PAGE }),
    getTranslations('admin.failedJobs'),
    getTranslations('admin'),
    getFormatter(),
  ])
  const pageCount = Math.ceil(total / ADMIN_PER_PAGE)
  const time = (value: string) => format.dateTime(new Date(value), { dateStyle: 'short', timeStyle: 'short' })

  /** 任务名和内容放在一格：邮件写模板、收件地址和收件人，其余任务显示载荷；不能重试的写明原因 */
  function job(item: AdminFailedJob) {
    const key = jobKey(item.name)
    const mail = mailPayload(item.name, item.payload)
    const title = mail?.template
      ? t('mailTitle', { template: t(`templates.${mail.template}`) })
      : key
        ? t(`names.${key}`)
        : null
    const hint = item.retryable ? null : mail?.linkRemoved ? t('linkRemoved') : key ? t('notRetryable') : t('noHandler')
    return (
      <span className="flex min-w-56 flex-col gap-0.5">
        {title ? <span className="font-medium">{title}</span> : <code className="font-mono">{item.name}</code>}
        {mail ? (
          <>
            {mail.to && <span className="text-sm wrap-anywhere">{t('mailTo', { to: mail.to })}</span>}
            {item.user ? (
              <span className="text-xs">
                <Link render={<NextLink href={`/admin/users/${item.user.uid}`} />}>
                  {t('recipient', { nickname: item.user.nickname })}
                </Link>
              </span>
            ) : (
              <span className="text-xs text-text-muted">{t('recipientGone')}</span>
            )}
          </>
        ) : (
          hasContent(item.payload) && (
            <code className="block max-w-md font-mono text-xs wrap-anywhere">{JSON.stringify(item.payload)}</code>
          )
        )}
        <span className="font-mono text-xs text-text-muted">
          #{item.id}
          {title && ` · ${item.name}`}
        </span>
        {hint && <span className="text-xs text-text-muted">{hint}</span>}
      </span>
    )
  }

  function error(text: string | null) {
    if (!text) return <span className="text-text-muted">{t('noError')}</span>
    const parsed = parseJobError(text)
    if (parsed.kind === 'raw') return <span className="block max-w-md font-mono text-xs wrap-anywhere">{text}</span>
    const summary =
      parsed.kind === 'known'
        ? t(`errors.${parsed.key}`)
        : parsed.known
          ? t(`errors.smtpCodes.${parsed.known}`)
          : t('errors.smtp', { code: parsed.code })
    return (
      <span className="flex max-w-sm min-w-48 flex-col gap-0.5">
        <span>{summary}</span>
        {parsed.kind === 'smtp' && parsed.status && (
          <span className="text-xs text-text-muted">{t('errors.smtpStatus', { status: parsed.status })}</span>
        )}
        <code className="font-mono text-xs text-text-muted">{text}</code>
      </span>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="flex items-baseline gap-3 font-pixel text-pixel-2 text-text">
          {t('title')}
          <span className="text-pixel-1 text-text-muted tabular-nums">{t('count', { count: total })}</span>
        </h1>
        <p className="text-sm text-pretty text-text-muted">{t('description')}</p>
      </header>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-text-muted">
          {t('pluginHint')}
          <Link render={<NextLink href="/admin/plugins" />}>{t('pluginLink')}</Link>
        </p>
        {latestId !== null && <FailedJobsBulkActions through={latestId} total={total} />}
      </div>

      <Table<Column>
        label={t('tableLabel')}
        empty={t('empty')}
        columns={[
          { key: 'job', header: t('columns.job') },
          { key: 'time', header: t('columns.time'), shrink: true },
          { key: 'error', header: t('columns.error') },
          { key: 'actions', header: t('columns.actions'), shrink: true },
        ]}
        rows={items.map((item) => ({
          key: item.id,
          cells: {
            job: job(item),
            time: (
              <span className="flex flex-col">
                <span>{t('failedAt', { time: time(item.failedAt) })}</span>
                <span className="text-xs text-text-muted">{t('createdAt', { time: time(item.createdAt) })}</span>
                <span className="text-xs text-text-muted">{t('attempts', { count: item.attempts })}</span>
              </span>
            ),
            error: error(item.lastError),
            actions: <FailedJobActions id={item.id} retryable={item.retryable} />,
          },
        }))}
      />

      <Pagination
        page={page}
        pageCount={pageCount}
        href={failedJobsHref}
        linkAs={NextLink}
        label={admin('pagination')}
        previousLabel={admin('previous')}
        nextLabel={admin('next')}
        pageLabel={(page) => admin('page', { page })}
      />
    </div>
  )
}
