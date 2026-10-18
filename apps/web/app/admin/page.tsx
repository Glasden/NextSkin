import { can } from '@nextskin/domain'
import { Alert, Link } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getFormatter, getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { getServer } from '../../lib/server'
import { requireAdmin } from '../../lib/session'
import { AuditTable } from './audit-table'
import { settingsHref } from './settings/setting-text'

// 概览上的配置检查各自对应的设置分区（ADR-0028）
const checkSections = { siteUrl: 'site', mail: 'mail', signingKey: 'yggdrasil' } as const

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.overview')
  return { title: t('title') }
}

/**
 * 后台的概览：站点的几个数字、待处理的举报、最近 10 条管理操作（ADR-0027）。超级管理员还会看到没完成的配置（ADR-0028）。
 * 插件的 admin.dashboard 插槽以后放在这里
 */
export default async function AdminOverviewPage() {
  const user = await requireAdmin('/admin')
  const { core } = await getServer()
  const canConfigure = can(user.role, 'settings.manage')
  const [overview, checks, t, format] = await Promise.all([
    core.admin.overview(user.uid),
    canConfigure ? core.admin.configChecks() : { missing: [] },
    getTranslations('admin.overview'),
    getFormatter(),
  ])
  const canReview = can(user.role, 'reports.review')
  const stats = [
    { label: t('pendingReports'), value: overview.pendingReports, href: canReview ? '/admin/reports' : null },
    { label: t('users'), value: overview.users, href: can(user.role, 'users.ban') ? '/admin/users' : null },
    { label: t('textures'), value: overview.textures, href: '/skinlib' },
    { label: t('registeredToday'), value: overview.registeredToday, href: null },
  ]

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-pixel text-pixel-2 text-text">{t('title')}</h1>
        <p className="text-sm text-pretty text-text-muted">{t('description')}</p>
      </header>

      {checks.missing.length > 0 && (
        <Alert tone="warning" title={t('checks.title')}>
          <ul className="flex flex-col gap-1">
            {checks.missing.map((item) => (
              <li key={item} className="flex flex-wrap items-baseline gap-x-3">
                {t(`checks.${item}`)}
                <Link render={<NextLink href={settingsHref(checkSections[item])} />}>{t('checks.fix')}</Link>
              </li>
            ))}
          </ul>
        </Alert>
      )}

      {canReview && overview.pendingReports > 0 && (
        <Alert tone="warning">
          <span className="flex flex-wrap items-baseline gap-x-3">
            {t('pendingAlert', { count: overview.pendingReports })}
            <Link render={<NextLink href="/admin/reports" />}>{t('pendingAction')}</Link>
          </span>
        </Alert>
      )}

      <section aria-label={t('stats')}>
        <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {stats.map((stat) => (
            <div key={stat.label} className="flex flex-col gap-1 rounded-md border border-border bg-surface p-4">
              <dt className="text-sm text-text-muted">
                {stat.href ? <Link render={<NextLink href={stat.href} />}>{stat.label}</Link> : stat.label}
              </dt>
              <dd className="font-pixel text-pixel-2 text-text tabular-nums">{format.number(stat.value)}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="font-pixel text-pixel-1 text-text-muted">{t('recentAudit')}</h2>
          {can(user.role, 'audit.read') && (
            <span className="text-sm">
              <Link render={<NextLink href="/admin/audit" />}>{t('allAudit')}</Link>
            </span>
          )}
        </div>
        <AuditTable entries={overview.recentAudit} label={t('recentAudit')} empty={t('noAudit')} />
      </section>
    </div>
  )
}
