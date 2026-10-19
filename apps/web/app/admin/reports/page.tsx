import { can, outranks, type AdminReport } from '@nextskin/domain'
import { Badge, FigurePlaceholder, Link, Pagination, SkinFigure, Table } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getFormatter, getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { getServer } from '../../../lib/server'
import { requireAdmin } from '../../../lib/session'
import { figureSrc } from '../../../lib/textures'
import { ADMIN_PER_PAGE, parseReportParams, reportsHref } from '../params'
import { ReportActions } from './report-actions'
import { ReportTabs } from './report-tabs'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.reports')
  return { title: t('title') }
}

type PendingColumn = 'texture' | 'uploader' | 'reporter' | 'reason' | 'createdAt' | 'actions'
type HandledColumn = 'texture' | 'uploader' | 'reporter' | 'reason' | 'resolution' | 'resolver' | 'resolvedAt'

const resolutionTones = { dismissed: 'neutral', textureDeleted: 'danger', uploaderBanned: 'danger' } as const

/**
 * 处理举报（ADR-0027）：待处理的从早到晚排，先来先处理；另外两种从新到旧。
 * 后台看得到被举报后改成私有的材质，缩略图按 hash 出图，不经过详情页的可见性检查
 */
export default async function AdminReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = parseReportParams(await searchParams)
  const user = await requireAdmin(reportsHref(params, { page: params.page }), 'reports.review')
  const { core } = await getServer()
  const [{ items, total, counts }, settings, t, admin, skinlib, format] = await Promise.all([
    core.admin.listReports(user.uid, { status: params.status, page: params.page, perPage: ADMIN_PER_PAGE }),
    core.settings.read(['report.reward', 'score.refundOnDelete']),
    getTranslations('admin.reports'),
    getTranslations('admin'),
    getTranslations('skinlib'),
    getFormatter(),
  ])
  const pageCount = Math.ceil(total / ADMIN_PER_PAGE)
  const manageUsers = can(user.role, 'users.ban')
  const manageTextures = can(user.role, 'textures.manage')
  const dateTime = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'short', timeStyle: 'short' })

  const person = (who: { uid: number; nickname: string } | null) =>
    who ? (
      manageUsers ? (
        <Link render={<NextLink href={`/admin/users/${who.uid}`} />}>{who.nickname}</Link>
      ) : (
        who.nickname
      )
    ) : (
      <span className="text-text-muted">{admin('userGone')}</span>
    )

  const textureCell = (report: AdminReport) => {
    const texture = report.texture
    const type = texture ? skinlib(`types.${texture.type}`) : null
    return (
      <span className="flex min-w-48 items-center gap-3 py-1">
        {/* 迷你展台：×3 的正面（DESIGN.md §5），看得清材质才好判断 */}
        <span className="grid h-26 w-14 shrink-0 place-items-center rounded-sm bg-stage">
          {texture ? (
            <SkinFigure
              src={figureSrc(texture.hash, texture.type)}
              type={texture.type}
              textureScale={texture.scale}
              scale={3}
              alt={skinlib('figureAlt', { name: texture.name, type: type! })}
            />
          ) : (
            <FigurePlaceholder scale={3} label={t('textureGone')} />
          )}
        </span>
        {texture ? (
          <span className="flex min-w-0 flex-col gap-1">
            <span className="min-w-0 truncate">
              {/* 别人的私有材质在详情页只对有 textures.manage 的人可见（ADR-0036），其他人只给公开的加链接 */}
              {texture.public || manageTextures ? (
                <Link render={<NextLink href={`/skinlib/${texture.tid}`} />}>{texture.name}</Link>
              ) : (
                texture.name
              )}
            </span>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
              <Badge>{type}</Badge>
              {!texture.public && <Badge>{t('private')}</Badge>}
              <span className="tabular-nums">{t('closets', { likes: texture.likes })}</span>
            </span>
          </span>
        ) : (
          <span className="text-text-muted">{t('textureGone')}</span>
        )}
      </span>
    )
  }

  const reporterCell = (report: AdminReport) => (
    <span className="flex flex-col">
      <span>{person(report.reporter)}</span>
      {report.scorePaid > 0 && (
        <span className="text-xs text-text-muted">{t('paid', { score: report.scorePaid })}</span>
      )}
    </span>
  )
  const reasonCell = (report: AdminReport) => (
    <p className="max-w-80 min-w-48 break-words whitespace-pre-line">{report.reason}</p>
  )

  const label = t('tableLabel', { status: t(`status.${params.status}`) })
  const empty = t(`empty.${params.status}`)
  const table =
    params.status === 'pending' ? (
      <Table<PendingColumn>
        label={label}
        empty={empty}
        columns={[
          { key: 'texture', header: t('columns.texture') },
          { key: 'uploader', header: t('columns.uploader') },
          { key: 'reporter', header: t('columns.reporter') },
          { key: 'reason', header: t('columns.reason') },
          { key: 'createdAt', header: t('columns.createdAt'), shrink: true },
          { key: 'actions', header: t('columns.actions'), shrink: true },
        ]}
        rows={items.map((report) => ({
          key: report.id,
          cells: {
            texture: textureCell(report),
            uploader: person(report.uploader),
            reporter: reporterCell(report),
            reason: reasonCell(report),
            createdAt: dateTime(report.createdAt),
            actions: report.texture ? (
              <ReportActions
                reward={settings['report.reward']}
                refund={settings['score.refundOnDelete']}
                report={{
                  id: report.id,
                  paid: report.scorePaid,
                  reporterGone: report.reporter === null,
                  texture: {
                    name: report.texture.name,
                    closets: report.texture.likes,
                    others: Math.max(0, report.texture.pendingReports - 1),
                  },
                  uploader: report.uploader?.nickname ?? null,
                  canBan: report.uploader !== null && outranks(user.role, report.uploader.role),
                }}
              />
            ) : null,
          },
        }))}
      />
    ) : (
      <Table<HandledColumn>
        label={label}
        empty={empty}
        columns={[
          { key: 'texture', header: t('columns.texture') },
          { key: 'uploader', header: t('columns.uploader') },
          { key: 'reporter', header: t('columns.reporter') },
          { key: 'reason', header: t('columns.reason') },
          { key: 'resolution', header: t('columns.resolution'), shrink: true },
          { key: 'resolver', header: t('columns.resolver'), shrink: true },
          { key: 'resolvedAt', header: t('columns.resolvedAt'), shrink: true },
        ]}
        rows={items.map((report) => ({
          key: report.id,
          cells: {
            texture: textureCell(report),
            uploader: person(report.uploader),
            reporter: reporterCell(report),
            reason: reasonCell(report),
            resolution: report.resolution ? (
              <Badge tone={resolutionTones[report.resolution]}>{t(`resolutions.${report.resolution}`)}</Badge>
            ) : (
              <span className="text-text-muted">—</span>
            ),
            resolver: report.resolver ? (
              report.resolver.nickname !== null ? (
                person({ uid: report.resolver.uid, nickname: report.resolver.nickname })
              ) : (
                <span className="text-text-muted">{t('resolverGone', { uid: report.resolver.uid })}</span>
              )
            ) : (
              <span className="text-text-muted">{report.resolution === 'textureDeleted' ? t('selfDeleted') : '—'}</span>
            ),
            resolvedAt: report.resolvedAt ? dateTime(report.resolvedAt) : '—',
          },
        }))}
      />
    )

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="flex items-baseline gap-3 font-pixel text-pixel-2 text-text">
          {t('title')}
          {counts.pending > 0 && (
            <span className="text-pixel-1 text-text-muted tabular-nums">{t('count', { count: counts.pending })}</span>
          )}
        </h1>
        <p className="text-sm text-pretty text-text-muted">
          {t('description')}
          {t('policy', { reward: settings['report.reward'] })}
        </p>
      </header>

      <ReportTabs params={params} counts={counts}>
        <div className="flex flex-col gap-4">
          {table}
          <Pagination
            page={params.page}
            pageCount={pageCount}
            href={(page) => reportsHref(params, { page })}
            linkAs={NextLink}
            label={admin('pagination')}
            previousLabel={admin('previous')}
            nextLabel={admin('next')}
            pageLabel={(page) => admin('page', { page })}
          />
        </div>
      </ReportTabs>
    </div>
  )
}
