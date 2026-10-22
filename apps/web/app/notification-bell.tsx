'use client'

import type { NotificationView } from '@nextskin/domain'
import { IconButton, Link, NotificationItem, Popover } from '@nextskin/ui'
import { useFormatter, useTranslations } from 'next-intl'
import NextLink from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Bell } from 'pixelarticons/react/Bell.js'
import { CheckDouble } from 'pixelarticons/react/CheckDouble.js'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { getJson, postJson, sendJson } from '../lib/api-client'

export interface NotificationSummary {
  /** 未读的条数，最多数到 100：到了 100 铃铛上写 99+ */
  unread: number
  /** 最新的 5 条未读 */
  latest: NotificationView[]
}

const FULL_PAGE = '/user/notifications'

function isSummary(data: unknown): data is NotificationSummary {
  return typeof data === 'object' && data !== null && 'unread' in data && 'latest' in data
}

/**
 * 页头的通知铃铛（ADR-0052）：角标是未读数，点开是最新的几条未读。首屏的值由页头在服务端查好；
 * 换页面、窗口重新获得焦点时再问一次，不轮询。点一条先标为已读再跳过去，没有链接的去完整列表看正文
 */
export function NotificationBell({ initial }: { initial: NotificationSummary }) {
  const t = useTranslations('site.notifications')
  const format = useFormatter()
  const router = useRouter()
  const pathname = usePathname()
  const [summary, setSummary] = useState(initial)
  const [open, setOpen] = useState(false)
  // router.refresh() 之后页头重新渲染，换上服务端的新值
  const [previous, setPrevious] = useState(initial)
  if (previous !== initial) {
    setPrevious(initial)
    setSummary(initial)
  }

  async function load() {
    const { status, data } = await getJson('/api/notifications/summary')
    if (status === 200 && isSummary(data)) setSummary(data)
  }
  const reload = useEffectEvent(() => void load())
  const first = useRef(true)
  useEffect(() => {
    // 首屏的值刚从服务端来，不用再问
    if (first.current) {
      first.current = false
      return
    }
    reload()
  }, [pathname])
  useEffect(() => {
    const onFocus = () => reload()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  /** 完整列表正开着时，它显示的已读状态跟着变 */
  function afterWrite() {
    if (window.location.pathname === FULL_PAGE) router.refresh()
  }

  function visit(item: NotificationView) {
    setOpen(false)
    setSummary((current) => ({
      unread: Math.max(0, current.unread - 1),
      latest: current.latest.filter((other) => other.id !== item.id),
    }))
    void sendJson('POST', `/api/notifications/${item.id}/read`).then(afterWrite)
  }

  async function readAll() {
    // 只标到浮层里最新的这一条：之后才到的通知用户还没看见
    const through = summary.latest[0]?.id
    if (through === undefined) return
    setSummary({ unread: 0, latest: [] })
    await postJson('/api/notifications/read-all', { through })
    await load()
    afterWrite()
  }

  const { unread, latest } = summary
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      title={t('title')}
      trigger={
        <IconButton label={unread ? t('labelUnread', { count: unread }) : t('label')} count={unread}>
          <Bell />
        </IconButton>
      }
      action={
        latest.length > 0 && (
          <IconButton size="sm" label={t('readAll')} onClick={() => void readAll()}>
            <CheckDouble />
          </IconButton>
        )
      }
      footer={
        <Link render={<NextLink href={FULL_PAGE} />} onClick={() => setOpen(false)}>
          {t('viewAll')}
        </Link>
      }
    >
      {latest.length > 0 ? (
        <div className="flex flex-col divide-y divide-border">
          {latest.map((item) => (
            <NotificationItem
              key={item.id}
              title={item.title}
              time={format.dateTime(new Date(item.createdAt), {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
              dateTime={item.createdAt}
              unread
              unreadLabel={t('unread')}
              render={<NextLink href={item.link ?? FULL_PAGE} />}
              onClick={() => visit(item)}
            />
          ))}
        </div>
      ) : (
        <p className="px-4 py-8 text-center text-sm text-text-muted">{t('empty')}</p>
      )}
    </Popover>
  )
}
