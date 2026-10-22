'use client'

import { Button, IconButton, Link, Tabs, useToast } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import NextLink from 'next/link'
import { useRouter } from 'next/navigation'
import { MailOpen } from 'pixelarticons/react/MailOpen.js'
import { Trash } from 'pixelarticons/react/Trash.js'
import { useOptimistic, useState, useTransition, type ReactNode } from 'react'
import { apiError, postJson, sendJson } from '../../../lib/api-client'
import { NOTIFICATION_FILTERS, notificationsHref, type NotificationParams } from './params'

/** 全部、未读：切换改的是地址，服务端只查当前这一种。标签先切过去，内容随后换上 */
export function NotificationTabs({
  params,
  unread,
  children,
}: {
  params: NotificationParams
  /** 未读数最多数到 100，到了就写 99+ */
  unread: number
  children: ReactNode
}) {
  const t = useTranslations('user.notifications')
  const router = useRouter()
  const [filter, setFilter] = useOptimistic(params.filter)
  const [, startTransition] = useTransition()
  return (
    <Tabs
      aria-label={t('tabsLabel')}
      value={filter}
      onValueChange={(next) =>
        startTransition(() => {
          setFilter(next)
          router.push(notificationsHref(params, { filter: next }))
        })
      }
      items={NOTIFICATION_FILTERS.map((value) => ({
        value,
        label: t(`tabs.${value}`),
        count: value === 'unread' && unread > 0 ? (unread > 99 ? '99+' : unread) : undefined,
      }))}
    >
      {children}
    </Tabs>
  )
}

/** 全部标为已读：只标到页面打开时最新的一条，之后才到的通知用户还没看见 */
export function ReadAllButton({ through }: { through: number }) {
  const t = useTranslations('user.notifications')
  const router = useRouter()
  const toast = useToast()
  const [pending, setPending] = useState(false)

  async function readAll() {
    setPending(true)
    const { status, data } = await postJson('/api/notifications/read-all', { through })
    setPending(false)
    if (status === 200)
      toast.show({ tone: 'success', title: t('readAllDone', { count: (data as { marked: number }).marked }) })
    else toast.show({ tone: 'danger', title: apiError(data)?.message ?? t('failed') })
    router.refresh()
  }

  return (
    <Button size="sm" variant="secondary" loading={pending} onClick={() => void readAll()}>
      {t('readAll')}
    </Button>
  )
}

/** 一条通知右边的操作：未读的可以标为已读；删除不可恢复，但只是自己的一条通知，不再确认 */
export function NotificationActions({ id, unread }: { id: number; unread: boolean }) {
  const t = useTranslations('user.notifications')
  const router = useRouter()
  const toast = useToast()
  const [pending, setPending] = useState<'read' | 'delete' | null>(null)

  async function run(action: 'read' | 'delete') {
    setPending(action)
    const { status, data } =
      action === 'read'
        ? await sendJson('POST', `/api/notifications/${id}/read`)
        : await sendJson('DELETE', `/api/notifications/${id}`)
    setPending(null)
    if (status === 200) {
      if (action === 'delete') toast.show({ tone: 'success', title: t('deleted') })
    } else toast.show({ tone: 'danger', title: apiError(data)?.message ?? t('failed') })
    router.refresh()
  }

  return (
    <>
      {unread && (
        <IconButton size="sm" label={t('markRead')} disabled={pending !== null} onClick={() => void run('read')}>
          <MailOpen />
        </IconButton>
      )}
      <IconButton size="sm" label={t('delete')} disabled={pending !== null} onClick={() => void run('delete')}>
        <Trash />
      </IconButton>
    </>
  )
}

/** 通知指向的页面。未读的点了顺便标为已读，不等结果：页面已经跳走了 */
export function NotificationLink({ id, unread, href }: { id: number; unread: boolean; href: string }) {
  const t = useTranslations('user.notifications')
  return (
    <Link
      render={<NextLink href={href} />}
      onClick={() => {
        if (unread) void sendJson('POST', `/api/notifications/${id}/read`)
      }}
    >
      {t('open')}
    </Link>
  )
}
