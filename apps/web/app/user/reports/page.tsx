import type { OwnReport } from '@nextskin/domain'
import { Badge, EmptyState, FigurePlaceholder, Link, Pagination, SkinFigure } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getFormatter, getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { Flag } from 'pixelarticons/react/Flag.js'
import { getServer } from '../../../lib/server'
import { requireUser } from '../../../lib/session'
import { figureSrc } from '../../../lib/textures'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('user.reports')
  return { title: t('title') }
}

const PER_PAGE = 20

const statusTones = { pending: 'warning', resolved: 'success', rejected: 'neutral' } as const

/** 我的举报：材质、理由、状态、提交时间（ADR-0026）。处理举报在后台做 */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requireUser('/user/reports')
  const raw = (await searchParams).page
  const pageParam = Array.isArray(raw) ? raw[0] : raw
  const page = pageParam && /^[1-9]\d{0,5}$/.test(pageParam) ? Number(pageParam) : 1
  const { core } = await getServer()
  const [{ items, total }, settings, t, actions, skinlib, common, format] = await Promise.all([
    core.reports.listOwn(user.uid, { page, perPage: PER_PAGE }),
    core.settings.read(['report.cost', 'report.reward']),
    getTranslations('user.reports'),
    getTranslations('skinlib.actions'),
    getTranslations('skinlib'),
    getTranslations('common'),
    getFormatter(),
  ])
  const pageCount = Math.ceil(total / PER_PAGE)
  const policy = [
    actions('reportCost', { cost: settings['report.cost'] }),
    actions('reportReward', { reward: settings['report.reward'] }),
  ].filter(Boolean)
  const dateTime = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' })

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="flex items-baseline gap-3 font-pixel text-pixel-2 text-text">
          {t('title')}
          {total > 0 && (
            <span className="text-pixel-1 text-text-muted tabular-nums">{t('count', { count: total })}</span>
          )}
        </h1>
        <p className="text-sm text-pretty text-text-muted">{t('description')}</p>
        {policy.length > 0 && (
          <p className="text-sm text-pretty text-text-muted">
            {policy.length === 2 ? common('sentences', { first: policy[0]!, second: policy[1]! }) : policy[0]}
          </p>
        )}
      </header>

      {items.length > 0 ? (
        <>
          <ul className="flex flex-col gap-3">
            {items.map((report) => (
              <ReportRow
                key={report.id}
                report={report}
                labels={{
                  status: t(`status.${report.status}`),
                  textureGone: t('textureGone'),
                  submitted: t('submittedAt', { time: dateTime(report.createdAt) }),
                  resolved: report.resolvedAt ? t('resolvedAt', { time: dateTime(report.resolvedAt) }) : null,
                  paid: report.scorePaid > 0 ? t('scorePaid', { score: report.scorePaid }) : null,
                  figure: report.texture
                    ? skinlib('figureAlt', { name: report.texture.name, type: skinlib(`types.${report.texture.type}`) })
                    : t('textureGone'),
                }}
              />
            ))}
          </ul>
          <Pagination
            page={page}
            pageCount={pageCount}
            href={(next) => (next > 1 ? `/user/reports?page=${next}` : '/user/reports')}
            linkAs={NextLink}
            label={t('pagination')}
            previousLabel={t('previous')}
            nextLabel={t('next')}
            pageLabel={(next) => t('page', { page: next })}
          />
        </>
      ) : (
        <EmptyState
          icon={<Flag />}
          title={t('emptyTitle')}
          description={t('emptyDescription')}
          action={<Link render={<NextLink href="/skinlib" />}>{t('emptyAction')}</Link>}
        />
      )}
    </div>
  )
}

function ReportRow({
  report,
  labels,
}: {
  report: OwnReport
  labels: {
    status: string
    textureGone: string
    submitted: string
    resolved: string | null
    paid: string | null
    figure: string
  }
}) {
  const texture = report.texture
  return (
    <li className="flex gap-4 rounded-md border border-border bg-surface p-4">
      {/* 迷你展台：×3 的正面（DESIGN.md §5） */}
      <div className="grid h-28 w-20 shrink-0 place-items-center rounded-sm bg-stage">
        {texture ? (
          <SkinFigure
            src={figureSrc(texture.hash, texture.type)}
            type={texture.type}
            textureScale={texture.scale}
            scale={3}
            alt={labels.figure}
          />
        ) : (
          <FigurePlaceholder scale={3} label={labels.figure} />
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {texture ? (
            <span className="min-w-0 truncate text-base font-medium">
              <Link render={<NextLink href={`/skinlib/${texture.tid}`} />}>{texture.name}</Link>
            </span>
          ) : (
            <span className="text-base text-text-muted">{labels.textureGone}</span>
          )}
          <Badge tone={statusTones[report.status]}>{labels.status}</Badge>
        </div>
        <p className="text-sm break-words whitespace-pre-line text-text">{report.reason}</p>
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-text-muted">
          <span>{labels.submitted}</span>
          {labels.resolved && <span>{labels.resolved}</span>}
          {labels.paid && <span>{labels.paid}</span>}
        </p>
      </div>
    </li>
  )
}
