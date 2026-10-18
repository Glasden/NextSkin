import { Badge, Link } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getFormatter, getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { notFound } from 'next/navigation'
import { getServer } from '../../../../lib/server'
import { requireAdmin } from '../../../../lib/session'
import { ReportView } from '../../../_import/report-view'
import { RUN_STATUS_TONES } from '../status'

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const [{ id }, t] = await Promise.all([params, getTranslations('admin.migration')])
  return { title: t('runTitle', { id }) }
}

/** 一次运行的对账报告（ADR-0031），可以下载 Markdown */
export default async function MigrationRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params
  const user = await requireAdmin(`/admin/migration/${raw}`, 'import.manage')
  if (!/^[1-9]\d{0,9}$/.test(raw) || Number(raw) > 2147483647) notFound()
  const { core, importer } = await getServer()
  await core.admin.requirePermission(user.uid, 'import.manage')
  const [result, t, format] = await Promise.all([
    importer.getRun(Number(raw)),
    getTranslations('admin.migration'),
    getFormatter(),
  ])
  if (!result) notFound()
  const { run, report } = result

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <span className="text-sm">
          <Link render={<NextLink href="/admin/migration" />}>{t('backToList')}</Link>
        </span>
        <h1 className="flex flex-wrap items-center gap-3 font-pixel text-pixel-2 text-text">
          {t('runTitle', { id: run.id })}
          <Badge tone={RUN_STATUS_TONES[run.status]}>{t(`statuses.${run.status}`)}</Badge>
        </h1>
        <p className="text-sm text-text-muted">
          {t('runMeta', {
            entry: t(`entries.${run.entry}`),
            by: run.startedBy ?? '—',
            time: format.dateTime(new Date(run.startedAt), { dateStyle: 'medium', timeStyle: 'short' }),
          })}
        </p>
      </header>
      {report ? (
        <>
          <span className="text-sm">
            <Link href={`/api/admin/import/runs/${run.id}/report.md`} download>
              {t('download')}
            </Link>
          </span>
          <ReportView report={report} status={run.status} />
        </>
      ) : (
        <p className="text-sm text-text-muted">{run.error ?? t('noReport')}</p>
      )}
    </div>
  )
}
