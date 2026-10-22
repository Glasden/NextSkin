import type { Meta, StoryObj } from '@storybook/react-vite'
import { Bell } from 'pixelarticons/react/Bell.js'
import { CheckDouble } from 'pixelarticons/react/CheckDouble.js'
import { useState } from 'react'
import { expect, fn, screen, userEvent, waitFor } from 'storybook/test'
import { IconButton } from '../icon-button/icon-button.tsx'
import { Link } from '../link/link.tsx'
import { NotificationItem } from '../notification-item/notification-item.tsx'
import { Popover } from './popover.tsx'

const onReadAll = fn()

const items = [
  { id: 1, title: '举报已采纳', time: '10 月 22 日 14:03' },
  { id: 2, title: '站点将于本周六凌晨 2 点到 4 点停机维护，期间皮肤站和外置登录都无法使用', time: '10 月 21 日 09:00' },
  { id: 3, title: '你的材质被下架了', time: '10 月 18 日 20:11' },
]

/** 页头的通知：点了一条之后浮层关掉，跳到它的链接 */
function Notifications({ count }: { count: number }) {
  const [open, setOpen] = useState(false)
  const shown = items.slice(0, count)
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      title="通知"
      trigger={
        <IconButton label={count ? `通知，${count} 条未读` : '通知'} count={count}>
          <Bell />
        </IconButton>
      }
      action={
        count > 0 && (
          <IconButton size="sm" label="全部标为已读" onClick={onReadAll}>
            <CheckDouble />
          </IconButton>
        )
      }
      footer={<Link href="#notifications">查看全部</Link>}
    >
      {shown.length ? (
        <div className="flex flex-col divide-y divide-border">
          {shown.map((item) => (
            <NotificationItem
              key={item.id}
              title={item.title}
              time={item.time}
              dateTime="2026-10-22T06:03:00.000Z"
              unread
              unreadLabel="未读"
              // 测试页里点了真的会跳走，story 只拦下默认行为；页面里换成框架的链接组件
              render={<a href={`#n-${item.id}`} onClick={(event) => event.preventDefault()} />}
              onClick={() => setOpen(false)}
            />
          ))}
        </div>
      ) : (
        <p className="px-4 py-8 text-center text-sm text-text-muted">没有新通知</p>
      )}
    </Popover>
  )
}

const meta = {
  title: 'Components/Popover',
  component: Popover,
  // 浮层渲染在 body 下、按视口定位，截图截整个视口
  tags: ['screenshot-viewport'],
  args: { title: '通知', trigger: <button type="button" />, children: null },
  decorators: [
    (Story) => (
      <div className="flex w-160 justify-end bg-surface p-2">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Popover>

export default meta
type Story = StoryObj<typeof meta>

/** 点铃铛打开，Esc 关闭后焦点回到铃铛；点一条通知关掉浮层。截图里浮层保持打开 */
export const Notification: Story = {
  render: () => <Notifications count={3} />,
  play: async ({ canvas }) => {
    const trigger = canvas.getByRole('button', { name: '通知，3 条未读' })
    await userEvent.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: '通知' })
    await expect(screen.getAllByRole('link', { name: /^未读：/ })).toHaveLength(3)
    await userEvent.click(screen.getByRole('button', { name: '全部标为已读' }))
    await expect(onReadAll).toHaveBeenCalledOnce()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(dialog).not.toBeVisible())
    await waitFor(() => expect(trigger).toHaveFocus())
    await userEvent.click(trigger)
    await userEvent.click(await screen.findByRole('link', { name: /举报已采纳/ }))
    await waitFor(() => expect(screen.queryByRole('dialog', { hidden: true })).toBeNull())
    await userEvent.click(trigger)
    await screen.findByRole('dialog', { name: '通知' })
    ;(document.activeElement as HTMLElement | null)?.blur()
  },
}

/** 没有未读：铃铛不带计数，浮层里说明一句，仍然能去完整列表 */
export const Empty: Story = {
  render: () => <Notifications count={0} />,
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole('button', { name: '通知' }))
    await screen.findByText('没有新通知')
    await expect(screen.queryByRole('button', { name: '全部标为已读' })).toBeNull()
    ;(document.activeElement as HTMLElement | null)?.blur()
  },
}
