import type { NotificationView } from '@nextskin/domain'
import { EmptyState, Link, Markdown, NotificationItem, Pagination } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getFormatter, getLocale, getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { Bell } from 'pixelarticons/react/Bell.js'
import { getServer } from '../../../lib/server'
import { requireUser } from '../../../lib/session'
import { NotificationActions, NotificationLink, NotificationTabs, ReadAllButton } from './notification-actions'
import { notificationsHref, parseNotificationParams } from './params'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('user.notifications')
  return { title: t('title') }
}

const PER_PAGE = 20

/**
 * 我的通知（ADR-0052）：最新的在前，每页 20 条，带正文。页头的铃铛只列最新的几条未读，看正文、删除、
 * 翻旧的都在这里。打开页面不会自动标为已读：点“查看”或“标为已读”才算
 */
export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = parseNotificationParams(await searchParams)
  const user = await requireUser(notificationsHref(params, { page: params.page }))
  // 被封禁的用户由布局换成封禁说明；页面和布局并行渲染，这里不去查（领域层会拒绝）
  if (user.role === 'banned') return null
  const [{ core }, locale] = await Promise.all([getServer(), getLocale()])
  const [{ items, total, unread, latestId }, t, format] = await Promise.all([
    core.notifications.list(user.uid, locale, params),
    getTranslations('user.notifications'),
    getFormatter(),
  ])
  const pageCount = Math.ceil(total / PER_PAGE)
  const dateTime = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' })

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="font-pixel text-pixel-2 text-text">{t('title')}</h1>
          <p className="text-sm text-pretty text-text-muted">{t('description')}</p>
        </div>
        {unread > 0 && latestId !== null && (
          <div className="shrink-0">
            <ReadAllButton through={latestId} />
          </div>
        )}
      </header>

      <NotificationTabs params={params} unread={unread}>
        {items.length > 0 ? (
          <div className="flex flex-col gap-6">
            <ul
              aria-label={t('listLabel')}
              className="flex flex-col divide-y divide-border rounded-md border border-border bg-surface"
            >
              {items.map((item) => (
                <li key={item.id}>
                  <NotificationItem
                    title={item.title}
                    time={dateTime(item.createdAt)}
                    dateTime={item.createdAt}
                    unread={item.readAt === null}
                    unreadLabel={t('tabs.unread')}
                    actions={<NotificationActions id={item.id} unread={item.readAt === null} />}
                  >
                    {content(item)}
                  </NotificationItem>
                </li>
              ))}
            </ul>
            <Pagination
              page={params.page}
              pageCount={pageCount}
              href={(page) => notificationsHref(params, { page })}
              linkAs={NextLink}
              label={t('pagination')}
              previousLabel={t('previous')}
              nextLabel={t('next')}
              pageLabel={(page) => t('page', { page })}
            />
          </div>
        ) : params.filter === 'unread' ? (
          <EmptyState
            icon={<Bell />}
            title={t('emptyUnreadTitle')}
            action={
              <Link render={<NextLink href={notificationsHref(params, { filter: 'all' })} />}>
                {t('emptyUnreadAction')}
              </Link>
            }
          />
        ) : (
          <EmptyState icon={<Bell />} title={t('emptyTitle')} description={t('emptyDescription')} />
        )}
      </NotificationTabs>
    </div>
  )

  /** 正文和“查看”链接。管理员写的通知按 Markdown 渲染，其余是按行分开的纯文本 */
  function content(item: NotificationView) {
    if (item.body === null && item.link === null) return undefined
    return (
      <div className="flex flex-col gap-2">
        {item.body !== null &&
          (item.format === 'markdown' ? (
            <Markdown>{item.body}</Markdown>
          ) : (
            <p className="break-words whitespace-pre-line">{item.body}</p>
          ))}
        {item.link !== null && (
          <span>
            <NotificationLink id={item.id} unread={item.readAt === null} href={item.link} />
          </span>
        )}
      </div>
    )
  }
}
