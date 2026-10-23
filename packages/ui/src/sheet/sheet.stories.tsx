import type { Meta, StoryObj } from '@storybook/react-vite'
import { Chart } from 'pixelarticons/react/Chart.js'
import { Flag } from 'pixelarticons/react/Flag.js'
import { Image } from 'pixelarticons/react/Image.js'
import { Menu } from 'pixelarticons/react/Menu.js'
import { Upload } from 'pixelarticons/react/Upload.js'
import { Users } from 'pixelarticons/react/Users.js'
import { expect, screen, userEvent, waitFor } from 'storybook/test'
import { IconButton } from '../icon-button/icon-button.tsx'
import { Logo } from '../logo/logo.tsx'
import { Nav, NavItem } from '../nav/nav.tsx'
import { Sheet } from './sheet.tsx'

const meta = {
  title: 'Components/Sheet',
  component: Sheet,
  // 侧边栏渲染在 body 下、按视口定位，截图截整个视口
  tags: ['screenshot-viewport'],
  args: { title: '', closeLabel: '关闭', children: null },
} satisfies Meta<typeof Sheet>

export default meta
type Story = StoryObj<typeof meta>

/**
 * 窄屏的导航：页头的“打开导航”从左边滑出，顶栏是链接到首页的标志，下面是全站导航和当前区域的分区。
 * 打开时焦点落在第一个链接上，Esc 关闭后焦点回到按钮
 */
export const Navigation: Story = {
  render: () => (
    <Sheet
      side="start"
      trigger={
        <IconButton label="打开导航">
          <Menu />
        </IconButton>
      }
      title={<Logo name="NextSkin" size="sm" render={<a href="#home" />} />}
      closeLabel="关闭导航"
    >
      <div className="flex flex-col gap-4 p-4">
        <Nav label="全站">
          <NavItem href="#skinlib" icon={<Image />}>
            皮肤库
          </NavItem>
          <NavItem href="#upload" icon={<Upload />}>
            上传
          </NavItem>
        </Nav>
        <Nav label="管理后台">
          <NavItem href="#overview" icon={<Chart />}>
            概览
          </NavItem>
          <NavItem href="#reports" icon={<Flag />} current>
            举报
          </NavItem>
          <NavItem href="#users" icon={<Users />}>
            用户
          </NavItem>
        </Nav>
      </div>
    </Sheet>
  ),
  play: async ({ canvas }) => {
    const trigger = canvas.getByRole('button', { name: '打开导航' })
    await userEvent.click(trigger)
    const sheet = await screen.findByRole('dialog', { name: 'NextSkin' })
    await waitFor(() => expect(sheet).toBeVisible())
    await expect(screen.getByRole('link', { name: '举报' })).toHaveAttribute('aria-current', 'page')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await expect(trigger).toHaveFocus()
    // 截图时开着：用键盘打开，右上角的关闭按钮可以用
    await userEvent.keyboard('{Enter}')
    await screen.findByRole('dialog', { name: 'NextSkin' })
    await expect(screen.getByRole('button', { name: '关闭导航' })).toBeVisible()
    ;(document.activeElement as HTMLElement | null)?.blur()
  },
}

/** 从右边滑出：查看和编辑详情，标题用像素字体 */
export const End: Story = {
  render: () => (
    <Sheet open title="材质详情" closeLabel="关闭">
      <p className="p-4 text-sm text-text">Steve 的皮肤，上传于 2026-10-01。</p>
    </Sheet>
  ),
  play: async () => {
    await expect(await screen.findByRole('dialog', { name: '材质详情' })).toBeVisible()
  },
}
