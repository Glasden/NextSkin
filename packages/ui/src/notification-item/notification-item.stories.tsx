import type { Meta, StoryObj } from '@storybook/react-vite'
import { MailOpen } from 'pixelarticons/react/MailOpen.js'
import { Trash } from 'pixelarticons/react/Trash.js'
import { expect, fn, userEvent } from 'storybook/test'
import { IconButton } from '../icon-button/icon-button.tsx'
import { Markdown } from '../markdown/markdown.tsx'
import { NotificationItem } from './notification-item.tsx'

const meta = {
  title: 'Components/NotificationItem',
  component: NotificationItem,
  args: {
    title: '举报已采纳',
    time: '10 月 22 日 14:03',
    dateTime: '2026-10-22T06:03:00.000Z',
    unreadLabel: '未读',
  },
  decorators: [
    (Story) => (
      <div className="w-96 rounded-md border border-border bg-surface">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof NotificationItem>

export default meta
type Story = StoryObj<typeof meta>

const onOpen = fn()

/** 弹出层里的一行：整条是链接，标题最多两行。未读的标题前面有强调色的方块，读屏先读“未读” */
export const Compact: Story = {
  render: (args) => (
    <div className="flex flex-col divide-y divide-border">
      {/* 测试页里点了真的会跳走，story 只拦下默认行为 */}
      <NotificationItem
        {...args}
        unread
        render={<a href="#reports" onClick={(event) => event.preventDefault()} />}
        onClick={onOpen}
      />
      <NotificationItem
        {...args}
        unread
        title="站点将于本周六凌晨 2 点到 4 点停机维护，期间皮肤站和外置登录都无法使用"
        time="10 月 21 日 09:00"
        render={<a href="#notifications" />}
      />
      <NotificationItem {...args} title="你的材质被下架了" time="10 月 18 日 20:11" render={<a href="#texture" />} />
    </div>
  ),
  play: async ({ canvas }) => {
    const first = canvas.getByRole('link', { name: /举报已采纳/ })
    await expect(first).toHaveAccessibleName(/^未读：\s*举报已采纳\s*10 月 22 日 14:03$/)
    await expect(canvas.getByRole('link', { name: /材质被下架/ })).toHaveAccessibleName(
      /^你的材质被下架了\s*10 月 18 日 20:11$/,
    )
    await userEvent.click(first)
    await expect(onOpen).toHaveBeenCalledOnce()
    ;(document.activeElement as HTMLElement | null)?.blur()
  },
}

const onRead = fn()

/** 完整列表里的一条：正文和右边的操作。纯文本按换行分行，管理员写的通知按 Markdown 渲染 */
export const WithBody: Story = {
  render: (args) => (
    <div className="flex flex-col divide-y divide-border">
      <NotificationItem
        {...args}
        unread
        title="管理员修改了你的账号"
        actions={
          <>
            <IconButton size="sm" label="标为已读" onClick={onRead}>
              <MailOpen />
            </IconButton>
            <IconButton size="sm" label="删除">
              <Trash />
            </IconButton>
          </>
        }
      >
        {'改了你的密码\n关闭了两步验证'}
      </NotificationItem>
      <NotificationItem
        {...args}
        title="周六停机维护"
        time="10 月 21 日 09:00"
        actions={
          <IconButton size="sm" label="删除">
            <Trash />
          </IconButton>
        }
      >
        <Markdown>
          {'本周六凌晨 **2 点到 4 点** 停机维护，期间皮肤站和外置登录都无法使用。\n\n详情见[公告](#announcement)。'}
        </Markdown>
      </NotificationItem>
    </div>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByText('改了你的密码', { exact: false })).toHaveTextContent('改了你的密码 关闭了两步验证')
    await userEvent.click(canvas.getByRole('button', { name: '标为已读' }))
    await expect(onRead).toHaveBeenCalledOnce()
    ;(document.activeElement as HTMLElement | null)?.blur()
  },
}
