import type { Meta, StoryObj } from '@storybook/react-vite'
import { Pencil } from 'pixelarticons/react/Pencil.js'
import { Logout } from 'pixelarticons/react/Logout.js'
import { MoreVertical } from 'pixelarticons/react/MoreVertical.js'
import { Trash } from 'pixelarticons/react/Trash.js'
import { User } from 'pixelarticons/react/User.js'
import { Users } from 'pixelarticons/react/Users.js'
import { expect, fn, screen, userEvent, waitFor } from 'storybook/test'
import { IconButton } from '../icon-button/icon-button.tsx'
import { Menu, MenuItem, MenuLinkItem, MenuSeparator } from './menu.tsx'

const onSignOut = fn()

const meta = {
  title: 'Components/Menu',
  component: Menu,
  // 菜单渲染在 body 下、按视口定位，截图截整个视口
  tags: ['screenshot-viewport'],
  args: {
    label: '史蒂夫',
    children: (
      <>
        <MenuLinkItem href="#user" icon={<User aria-hidden />}>
          用户中心
        </MenuLinkItem>
        <MenuLinkItem href="#players" icon={<Users aria-hidden />}>
          角色管理
        </MenuLinkItem>
        <MenuSeparator />
        <MenuItem onClick={onSignOut} icon={<Logout aria-hidden />}>
          退出登录
        </MenuItem>
      </>
    ),
  },
} satisfies Meta<typeof Menu>

export default meta
type Story = StoryObj<typeof meta>

/** 键盘打开菜单，方向键移动，回车执行；Esc 关闭后焦点回到触发按钮。截图里菜单保持打开 */
export const UserMenu: Story = {
  name: 'User menu',
  play: async ({ canvas }) => {
    const trigger = canvas.getByRole('button', { name: '史蒂夫' })
    await userEvent.click(trigger)
    const menu = await screen.findByRole('menu')
    await expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      '用户中心',
      '角色管理',
      '退出登录',
    ])
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(menu).not.toBeVisible())
    await expect(trigger).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    await waitFor(() => expect(screen.getByRole('menuitem', { name: '用户中心' })).toHaveFocus())
    await userEvent.keyboard('{End}{Enter}')
    await expect(onSignOut).toHaveBeenCalledOnce()
    // 等退场的菜单卸载再点：不然下面的 findByRole 找到的是正在关闭的那个，截图时菜单已经关了
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await userEvent.click(trigger)
    await screen.findByRole('menu')
  },
}

/** 菜单靠右对齐触发按钮，放在页头右上角时不伸出屏幕 */
export const AlignEnd: Story = {
  name: 'Align end',
  args: { align: 'end', label: '一个很长很长的昵称会被截断' },
  decorators: [
    (Story) => (
      <div className="flex w-160 justify-end">
        <div className="w-48">
          <Story />
        </div>
      </div>
    ),
  ],
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole('button', { name: '一个很长很长的昵称会被截断' }))
    await screen.findByRole('menu')
  },
}

const onRemove = fn()

/** 换掉默认的触发按钮：衣柜卡片右上角的“更多”。菜单项是对这一件的操作 */
export const IconTrigger: Story = {
  name: 'Icon trigger',
  args: {
    label: undefined,
    trigger: (
      <IconButton size="sm" label="上学穿的更多操作">
        <MoreVertical />
      </IconButton>
    ),
    children: (
      <>
        <MenuItem icon={<Pencil aria-hidden />}>改名</MenuItem>
        <MenuSeparator />
        <MenuItem icon={<Trash aria-hidden />} onClick={onRemove}>
          移出衣柜
        </MenuItem>
      </>
    ),
  },
  play: async ({ canvas }) => {
    const trigger = canvas.getByRole('button', { name: '上学穿的更多操作' })
    await userEvent.click(trigger)
    await screen.findByRole('menu')
    await userEvent.click(screen.getByRole('menuitem', { name: '移出衣柜' }))
    await expect(onRemove).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await userEvent.click(trigger)
    await screen.findByRole('menu')
  },
}
