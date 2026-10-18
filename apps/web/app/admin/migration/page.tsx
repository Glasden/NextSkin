import { Alert, Badge, EmptyState, Link, Pagination, Table } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getFormatter, getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { Database } from 'pixelarticons/react/Database.js'
import { getServer } from '../../../lib/server'
import { requireAdmin } from '../../../lib/session'
import { RUN_STATUS_TONES } from './status'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.migration')
  return { title: t('title') }
}

const PER_PAGE = 20

type Column = 'id' | 'status' | 'startedAt' | 'source' | 'totals' | 'startedBy' | 'actions'

/**
 * 数据迁移（ADR-0031）：历次运行（试跑和导入）的时间、结果和报告；“开始导入”走和安装向导相同的步骤。
 * 只有超级管理员能进来（import.manage）
 */
export default async function MigrationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const raw = (await searchParams).page
  const page = typeof raw === 'string' && /^[1-9]\d{0,5}$/.test(raw) ? Number(raw) : 1
  const user = await requireAdmin(page > 1 ? `/admin/migration?page=${page}` : '/admin/migration', 'import.manage')
  const { core, importer } = await getServer()
  await core.admin.requirePermission(user.uid, 'import.manage')
  const [{ runs, total }, t, admin, format] = await Promise.all([
    importer.listRuns(page, PER_PAGE),
    getTranslations('admin.migration'),
    getTranslations('admin'),
    getFormatter(),
  ])
  const pageCount = Math.ceil(total / PER_PAGE)
  const dateTime = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' })

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-pixel text-pixel-2 text-text">{t('title')}</h1>
          <p className="max-w-3xl text-sm text-pretty text-text-muted">{t('description')}</p>
        </div>
        <Link render={<NextLink href="/admin/migration/new" />}>{t('start')}</Link>
      </header>

      <Alert title={t('noticeTitle')}>{t('notice')}</Alert>

      {total === 0 ? (
        <EmptyState
          icon={<Database />}
          title={t('emptyTitle')}
          description={t('empty')}
          action={<Link render={<NextLink href="/admin/migration/new" />}>{t('start')}</Link>}
        />
      ) : (
        <>
          <Table<Column>
            label={t('tableLabel')}
            empty={t('empty')}
            columns={[
              { key: 'id', header: t('columns.id'), align: 'end', shrink: true },
              { key: 'status', header: t('columns.status'), shrink: true },
              { key: 'startedAt', header: t('columns.startedAt'), shrink: true },
              { key: 'source', header: t('columns.source') },
              { key: 'totals', header: t('columns.totals') },
              { key: 'startedBy', header: t('columns.startedBy') },
              { key: 'actions', header: t('columns.actions'), shrink: true },
            ]}
            rows={runs.map((run) => {
              const connection = run.source.connection
              return {
                key: run.id,
                cells: {
                  id: <span className="font-mono">{run.id}</span>,
                  status: (
                    <span className="flex flex-wrap gap-1">
                      <Badge tone={RUN_STATUS_TONES[run.status]}>{t(`statuses.${run.status}`)}</Badge>
                      {run.dryRun && <Badge>{t('dryRun')}</Badge>}
                    </span>
                  ),
                  startedAt: <span className="whitespace-nowrap">{dateTime(run.startedAt)}</span>,
                  source: (
                    <span className="font-mono break-all">
                      {connection.dialect === 'sqlite'
                        ? connection.file
                        : `${connection.dialect}://${connection.host}:${connection.port}/${connection.database}`}
                    </span>
                  ),
                  totals: run.totals ? (
                    <span className="whitespace-nowrap">
                      {run.totals.blocking > 0
                        ? t('blocking', { count: run.totals.blocking })
                        : t('totals', {
                            users: format.number(run.totals.users),
                            players: format.number(run.totals.players),
                            textures: format.number(run.totals.textures),
                          })}
                    </span>
                  ) : (
                    <span className="text-text-muted">{run.error ?? '—'}</span>
                  ),
                  startedBy: run.startedBy ?? (
                    <span className="whitespace-nowrap text-text-muted">{t(`entries.${run.entry}`)}</span>
                  ),
                  actions: run.totals ? (
                    <Link render={<NextLink href={`/admin/migration/${run.id}`} />}>{t('view')}</Link>
                  ) : null,
                },
              }
            })}
          />
          {pageCount > 1 && (
            <Pagination
              page={page}
              pageCount={pageCount}
              href={(target) => (target > 1 ? `/admin/migration?page=${target}` : '/admin/migration')}
              linkAs={NextLink}
              label={admin('pagination')}
              previousLabel={admin('previous')}
              nextLabel={admin('next')}
              pageLabel={(target) => admin('page', { page: target })}
            />
          )}
        </>
      )}
    </div>
  )
}
