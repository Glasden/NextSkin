'use client'

import { useRender } from '@base-ui/react/use-render'
import type { ReactElement, ReactNode } from 'react'
import { cx } from '../cx.ts'

export interface NotificationItemProps {
  /** 通知的标题，已经按读者的语言写好 */
  title: string
  /** 写好的时间，例如“10 月 22 日 14:03” */
  time: string
  /** 同一时刻的 ISO 字符串，写进 `<time>` 的 dateTime。没有真实的时刻时不传，例如发送前的预览 */
  dateTime?: string
  /** 未读：标题前面一个强调色的方块，标题加粗 */
  unread?: boolean
  /** 未读时读屏读出的文字，例如“未读”。方块本身对读屏隐藏，不只靠颜色表达状态（DESIGN.md §9） */
  unreadLabel?: string
  /**
   * 整条是一个链接，用在页头的弹出层里：只显示标题和时间。站内跳转传框架的链接组件，
   * 例如 `render={<NextLink href="/user/reports" />}`
   */
  render?: ReactElement
  onClick?: () => void
  /** 正文，用在完整的通知列表里：纯文本按换行分行；管理员写的通知传 Markdown */
  children?: ReactNode
  /** 右边的操作，例如“标为已读”“删除”的小号 IconButton。整条是链接时不放 */
  actions?: ReactNode
}

// 链接行悬停时底色混入 12% 的 text（DESIGN.md §2）；焦点框画在行内，放在滚动的浮层里不会被裁掉
const linkRow = cx(
  'hover:bg-[color-mix(in_srgb,var(--color-surface-raised)_88%,var(--color-text))]',
  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
)

/**
 * 一条通知：页头弹出层里是一行链接（标题和时间），完整列表里再带正文和操作。
 * 外层的列表负责分隔线，这里不画边框
 */
export function NotificationItem({ render, onClick, children, actions, ...props }: NotificationItemProps) {
  if (render) return <NotificationLink {...props} render={render} onClick={onClick} />
  return (
    <div className="flex gap-3 px-4 py-3">
      <UnreadMark {...props} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Title {...props} />
        {children !== undefined && (
          <div className={cx('mt-1 text-sm text-text', typeof children === 'string' && 'whitespace-pre-line')}>
            {children}
          </div>
        )}
      </div>
      {actions && <div className="-my-1 flex shrink-0 items-start gap-1">{actions}</div>}
    </div>
  )
}

type TitleProps = Pick<NotificationItemProps, 'title' | 'time' | 'dateTime' | 'unread' | 'unreadLabel'>

function NotificationLink({
  render,
  onClick,
  ...props
}: TitleProps & { render: ReactElement; onClick?: (() => void) | undefined }) {
  return useRender({
    defaultTagName: 'a',
    render,
    props: {
      className: cx('flex gap-3 px-4 py-3', linkRow),
      onClick,
      children: (
        <>
          <UnreadMark {...props} />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <Title {...props} clamp />
          </span>
        </>
      ),
    },
  })
}

/** 未读的方块：8px，和标题的第一行居中对齐；已读时留着位置，标题不跟着左右移动 */
function UnreadMark({ unread = false }: TitleProps) {
  return <span aria-hidden className={cx('mt-1.5 size-2 shrink-0', unread ? 'bg-accent' : 'bg-transparent')} />
}

function Title({ title, time, dateTime, unread = false, unreadLabel, clamp }: TitleProps & { clamp?: boolean }) {
  return (
    <>
      <span className={cx('text-sm text-pretty text-text', unread && 'font-medium', clamp && 'line-clamp-2')}>
        {unread && unreadLabel && <span className="sr-only">{unreadLabel}：</span>}
        {title}
      </span>
      <time dateTime={dateTime} className="text-xs text-text-muted tabular-nums">
        {time}
      </time>
    </>
  )
}
