import { Link, Pagination } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { getServer } from '../../../lib/server'
import { requireAdmin } from '../../../lib/session'
import { AuditTable } from '../audit-table'
import { ADMIN_PER_PAGE, auditHref, parseAuditParams } from '../params'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.audit')
  return { title: t('title') }
}

/** 审计日志（ADR-0027）：按时间从新到旧，可以只看某个操作者或某个对象的记录 */
export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = parseAuditParams(await searchParams)
  const user = await requireAdmin(auditHref(params, { page: params.page }), 'audit.read')
  const { core } = await getServer()
  const [{ items, total }, t, admin] = await Promise.all([
    core.admin.listAudit(user.uid, {
      subjectType: params.subject?.type,
      subjectId: params.subject?.id,
      actorUid: params.actor ?? undefined,
      page: params.page,
      perPage: ADMIN_PER_PAGE,
    }),
    getTranslations('admin.audit'),
    getTranslations('admin'),
  ])
  const pageCount = Math.ceil(total / ADMIN_PER_PAGE)
  const subject = params.subject
  const filters = [
    params.actor !== null && t('filterActor', { uid: params.actor }),
    subject &&
      t('filterSubject', {
        subject:
          subject.type === 'user' || subject.type === 'texture' || subject.type === 'report'
            ? t(`subjects.${subject.type}`, { id: subject.id })
            : t('subjects.other', { type: subject.type, id: subject.id }),
      }),
  ].filter((filter): filter is string => typeof filter === 'string')

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-pixel text-pixel-2 text-text">{t('title')}</h1>
        <p className="text-sm text-pretty text-text-muted">{t('description')}</p>
      </header>

      {filters.length > 0 && (
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-text">
          {filters.map((filter) => (
            <span key={filter}>{filter}</span>
          ))}
          <Link render={<NextLink href="/admin/audit" />}>{t('clearFilter')}</Link>
        </p>
      )}

      <AuditTable entries={items} label={t('tableLabel')} empty={filters.length ? t('emptyFiltered') : t('empty')} />

      <Pagination
        page={params.page}
        pageCount={pageCount}
        href={(page) => auditHref(params, { page })}
        linkAs={NextLink}
        label={admin('pagination')}
        previousLabel={admin('previous')}
        nextLabel={admin('next')}
        pageLabel={(page) => admin('page', { page })}
      />
    </div>
  )
}
