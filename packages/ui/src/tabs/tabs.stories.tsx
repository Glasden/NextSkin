import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, fn, screen, userEvent, waitFor } from 'storybook/test'
import { Tabs } from './tabs.tsx'

const onValueChange = fn()

const meta = {
  title: 'Components/Tabs',
  component: Tabs,
  args: {
    'aria-label': '衣柜分类',
    items: [
      { value: 'skin', label: '皮肤', count: 12 },
      { value: 'cape', label: '披风', count: 3 },
    ],
    onValueChange,
    children: null,
  },
} satisfies Meta<typeof Tabs>

export default meta
type Story = StoryObj<typeof meta>

/** 衣柜的皮肤和披风。点击或方向键加 Enter 切换，底边的色块挪过去；只渲染当前这一页的内容 */
export const Default: Story = {
  render: function Render(args) {
    const [value, setValue] = useState('skin')
    return (
      <div className="w-120">
        <Tabs
          {...args}
          value={value}
          onValueChange={(next) => {
            setValue(next)
            args.onValueChange?.(next)
          }}
        >
          <p className="text-sm text-text-muted">{value === 'skin' ? '12 件皮肤' : '3 件披风'}</p>
        </Tabs>
      </div>
    )
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('tablist', { name: '衣柜分类' })).toBeVisible()
    const skin = canvas.getByRole('tab', { name: '皮肤 12' })
    const cape = canvas.getByRole('tab', { name: '披风 3' })
    await expect(skin).toHaveAttribute('aria-selected', 'true')
    await expect(canvas.getByRole('tabpanel')).toHaveTextContent('12 件皮肤')
    await userEvent.click(cape)
    await expect(onValueChange).toHaveBeenLastCalledWith('cape')
    await expect(cape).toHaveAttribute('aria-selected', 'true')
    await expect(canvas.getByRole('tabpanel')).toHaveTextContent('3 件披风')
    await userEvent.keyboard('{ArrowLeft}')
    await expect(skin).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    await expect(skin).toHaveAttribute('aria-selected', 'true')
    // 结束前移开焦点：模拟点击留下的焦点框，真实的鼠标点击不会有
    ;(document.activeElement as HTMLElement | null)?.blur()
  },
}

/** 键盘聚焦时的焦点框 */
export const Focused: Story = {
  render: (args) => (
    <div className="w-120">
      <Tabs {...args} defaultValue="skin">
        <p className="text-sm text-text-muted">12 件皮肤</p>
      </Tabs>
    </div>
  ),
  play: async ({ canvas }) => {
    await userEvent.tab()
    await expect(canvas.getByRole('tab', { name: '皮肤 12' })).toHaveFocus()
  },
}

/** 不可用的标签：看得见但点不了 */
export const Disabled: Story = {
  args: {
    items: [
      { value: 'all', label: '全部', count: 128 },
      { value: 'pending', label: '待处理', count: 4 },
      { value: 'resolved', label: '已采纳', count: 0, disabled: true },
      { value: 'rejected', label: '已驳回' },
    ],
  },
  render: (args) => (
    <div className="w-120">
      <Tabs {...args} defaultValue="pending">
        <p className="text-sm text-text-muted">4 个待处理的举报</p>
      </Tabs>
    </div>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('tab', { name: '已采纳 0' })).toHaveAttribute('aria-disabled', 'true')
    await expect(canvas.getByRole('tab', { name: '待处理 4' })).toHaveAttribute('aria-selected', 'true')
  },
}

/** 放不下时横向滚动，不换行 */
export const Overflow: Story = {
  args: {
    items: [
      { value: 'skin', label: '皮肤', count: 1024 },
      { value: 'cape', label: '披风', count: 256 },
      { value: 'uploaded', label: '我上传的', count: 64 },
      { value: 'reported', label: '我举报的', count: 2 },
    ],
  },
  render: (args) => (
    <div className="w-60">
      <Tabs {...args} defaultValue="cape">
        <p className="text-sm text-text-muted">256 件披风</p>
      </Tabs>
    </div>
  ),
}

/** 标签多的放在窄容器里：开了 collapse 换成 Select，选了一样切换；容器宽了照旧是一排标签 */
export const Collapse: Story = {
  args: {
    'aria-label': '设置分区',
    collapse: true,
    items: [
      { value: 'site', label: '站点' },
      { value: 'registration', label: '注册' },
      { value: 'captcha', label: '验证码' },
      { value: 'score', label: '积分' },
      { value: 'content', label: '角色和材质' },
      { value: 'mail', label: '邮件' },
      { value: 'yggdrasil', label: 'Yggdrasil' },
      { value: 'maintenance', label: '维护' },
      { value: 'advanced', label: '高级' },
    ],
  },
  render: function Render(args) {
    const [value, setValue] = useState('site')
    return (
      <div className="w-80">
        <Tabs
          {...args}
          value={value}
          onValueChange={(next) => {
            setValue(next)
            args.onValueChange?.(next)
          }}
        >
          <p className="text-sm text-text-muted">{value === 'site' ? '站点名称、标志' : '邮件服务器'}</p>
        </Tabs>
      </div>
    )
  },
  play: async ({ canvas }) => {
    await expect(canvas.queryByRole('tablist')).toBeNull()
    const select = canvas.getByRole('combobox', { name: '设置分区' })
    await expect(select).toHaveTextContent('站点')
    await userEvent.click(select)
    await userEvent.click(await screen.findByRole('option', { name: '邮件' }))
    await expect(onValueChange).toHaveBeenLastCalledWith('mail')
    await expect(canvas.getByRole('tabpanel')).toHaveTextContent('邮件服务器')
    await expect(select).toHaveTextContent('邮件')
    // 弹层退场后焦点才回到选择框，等它回来再移走，否则截图时有没有焦点环看时机
    await waitFor(() => expect(select).toHaveFocus())
    ;(document.activeElement as HTMLElement | null)?.blur()
  },
}
