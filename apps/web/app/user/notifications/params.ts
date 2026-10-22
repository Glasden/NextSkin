// 筛选和页码都在地址里，同后台的列表（admin/params.ts）

export const NOTIFICATION_FILTERS = ['all', 'unread'] as const
export type NotificationFilter = (typeof NOTIFICATION_FILTERS)[number]

export interface NotificationParams {
  filter: NotificationFilter
  page: number
}

type SearchParams = Record<string, string | string[] | undefined>

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? ''
}

/** 不认识的值一律取默认值，不报错：地址可能是手改的 */
export function parseNotificationParams(search: SearchParams): NotificationParams {
  const filter = first(search.filter)
  const page = first(search.page)
  return {
    filter: (NOTIFICATION_FILTERS as readonly string[]).includes(filter) ? (filter as NotificationFilter) : 'all',
    page: /^[1-9]\d{0,5}$/.test(page) ? Number(page) : 1,
  }
}

/** 换了筛选就回到第一页；默认值不写进地址 */
export function notificationsHref(params: NotificationParams, changes: Partial<NotificationParams> = {}): string {
  const next = { ...params, page: 1, ...changes }
  const query = new URLSearchParams()
  if (next.filter !== 'all') query.set('filter', next.filter)
  if (next.page > 1) query.set('page', String(next.page))
  const search = query.toString()
  return search ? `/user/notifications?${search}` : '/user/notifications'
}
