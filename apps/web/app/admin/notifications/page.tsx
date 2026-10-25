import { can } from '@nextskin/domain'
import { Badge, Link, Pagination, Table } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getFormatter, getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { getServer } from '../../../lib/server'
import { requireAdmin } from '../../../lib/session'
import { ADMIN_PER_PAGE, notificationsHref, parseNotificationParams } from '../params'
import { NotificationComposer } from './notification-composer'
import { RecallDialog } from './recall-dialog'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.notifications')
  return { title: t('title') }
}

type Column = 'title' | 'audience' | 'sender' | 'status' | 'time' | 'actions'

const statusTones = { sending: 'warning', sent: 'success', recalled: 'neutral' } as const

/**
 * 后台发通知（ADR-0052）：上面写、下面是发送记录，最新的在前。从用户详情页进来时（`?to=5`）收件人已经选好；
 * 这个用户不在了就从群发开始。
 * 送达人数是群发展开到现在写出的条数，发送中的会继续涨
 */
export default async function AdminNotificationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = parseNotificationParams(await searchParams)
  const viewer = await requireAdmin(notificationsHref(params.page), 'notifications.send')
  const { core } = await getServer()
  const [{ items, total }, to, t, admin, format] = await Promise.all([
    core.admin.listNotificationBroadcasts({ uid: viewer.uid, ip: null }, { page: params.page }),
    params.to === null
      ? null
      : core.admin
          .searchNotificationRecipients(viewer.uid, String(params.to))
          .then((users) => users.find((user) => user.uid === params.to) ?? null),
    getTranslations('admin.notifications'),
    getTranslations('admin'),
    getFormatter(),
  ])
  const pageCount = Math.ceil(total / ADMIN_PER_PAGE)
  const manageUsers = can(viewer.role, 'users.ban')
  const time = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'short', timeStyle: 'short' })

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="font-pixel text-pixel-2 text-text">{t('title')}</h1>
        <p className="text-sm text-pretty text-text-muted">{t('description')}</p>
      </header>

      <section aria-labelledby="compose-heading" className="flex flex-col gap-4">
        <h2 id="compose-heading" className="font-pixel text-pixel-1 text-text">
          {t('compose')}
        </h2>
        <NotificationComposer to={to} />
      </section>

      <section aria-labelledby="history-heading" className="flex flex-col gap-4">
        <h2 id="history-heading" className="flex items-baseline gap-3 font-pixel text-pixel-1 text-text">
          {t('history')}
          {total > 0 && <span className="text-text-muted tabular-nums">{t('historyCount', { count: total })}</span>}
        </h2>
        <Table<Column>
          label={t('tableLabel')}
          empty={t('empty')}
          columns={[
            { key: 'title', header: t('columns.title') },
            { key: 'audience', header: t('columns.audience'), shrink: true },
            { key: 'sender', header: t('columns.sender'), shrink: true },
            { key: 'status', header: t('columns.status'), shrink: true },
            { key: 'time', header: t('columns.time'), shrink: true },
            { key: 'actions', header: t('columns.actions'), shrink: true },
          ]}
          rows={items.map((item) => ({
            key: item.id,
            cells: {
              title: (
                <span className="flex min-w-48 flex-col gap-0.5">
                  <span className="break-words">{item.title}</span>
                  <span className="font-mono text-xs text-text-muted">#{item.id}</span>
                </span>
              ),
              audience: t(`audiences.${item.audience}`),
              sender: item.sender ? (
                manageUsers ? (
                  <Link render={<NextLink href={`/admin/users/${item.sender.uid}`} />}>{item.sender.nickname}</Link>
                ) : (
                  item.sender.nickname
                )
              ) : (
                <span className="text-text-muted">{admin('userGone')}</span>
              ),
              status: (
                <span className="flex flex-col items-start gap-1">
                  <Badge tone={statusTones[item.status]}>{t(`status.${item.status}`)}</Badge>
                  <span className="text-xs text-text-muted tabular-nums">
                    {t('delivered', { count: item.recipientCount })}
                  </span>
                </span>
              ),
              time: <time dateTime={item.createdAt}>{time(item.createdAt)}</time>,
              actions: item.status !== 'recalled' && <RecallDialog id={item.id} title={item.title} />,
            },
          }))}
        />
        <Pagination
          page={params.page}
          pageCount={pageCount}
          href={notificationsHref}
          linkAs={NextLink}
          label={admin('pagination')}
          previousLabel={admin('previous')}
          nextLabel={admin('next')}
          pageLabel={(page) => admin('page', { page })}
        />
      </section>
    </div>
  )
}
