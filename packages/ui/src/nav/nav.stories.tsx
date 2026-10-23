import type { Meta, StoryObj } from '@storybook/react-vite'
import { Layout } from 'pixelarticons/react/Layout.js'
import { Star } from 'pixelarticons/react/Star.js'
import { User } from 'pixelarticons/react/User.js'
import { Users } from 'pixelarticons/react/Users.js'
import { expect, userEvent } from 'storybook/test'
import { Nav, NavItem } from './nav.tsx'

const meta = {
  title: 'Components/Nav',
  component: Nav,
  args: {
    label: '用户中心',
    children: (
      <>
        <NavItem href="#dashboard" icon={<Layout />}>
          仪表盘
        </NavItem>
        <NavItem href="#players" icon={<Users />} current>
          角色
        </NavItem>
        <NavItem href="#closet" icon={<Star />}>
          衣柜
        </NavItem>
        <NavItem href="#profile" icon={<User />}>
          个人资料
        </NavItem>
      </>
    ),
  },
} satisfies Meta<typeof Nav>

export default meta
type Story = StoryObj<typeof meta>

/** 宽屏的侧栏：竖排，当前项左边有一条强调色的竖条。键盘聚焦的那一项显示焦点框 */
export const Sidebar: Story = {
  decorators: [
    (Story) => (
      <div className="w-56">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvas }) => {
    const nav = canvas.getByRole('navigation', { name: '用户中心' })
    await expect(nav).toBeVisible()
    await expect(canvas.getByRole('link', { name: '角色' })).toHaveAttribute('aria-current', 'page')
    await expect(canvas.getByRole('link', { name: '仪表盘' })).not.toHaveAttribute('aria-current')
    await userEvent.tab()
    await expect(canvas.getByRole('link', { name: '仪表盘' })).toHaveFocus()
  },
}

/** 页头里的全站导航：始终横排，当前项的标记在底边 */
export const Header: Story = {
  args: {
    label: '全站',
    placement: 'header',
    children: (
      <>
        <NavItem href="#skinlib" icon={<Layout />} current>
          皮肤库
        </NavItem>
        <NavItem href="#user" icon={<User />}>
          用户中心
        </NavItem>
      </>
    ),
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('link', { name: '皮肤库' })).toHaveAttribute('aria-current', 'page')
  },
}
