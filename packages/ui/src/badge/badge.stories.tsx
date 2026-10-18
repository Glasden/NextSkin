import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect } from 'storybook/test'
import { Badge } from './badge.tsx'

const meta = {
  title: 'Components/Badge',
  component: Badge,
  args: { children: '已开启' },
} satisfies Meta<typeof Badge>

export default meta
type Story = StoryObj<typeof meta>

export const Tones: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <Badge>未开启</Badge>
      <Badge tone="success">已开启</Badge>
      <Badge tone="warning">未验证</Badge>
      <Badge tone="danger">已封禁</Badge>
    </div>
  ),
  play: async ({ canvas }) => {
    // 只是文字，不是控件
    await expect(canvas.queryAllByRole('button')).toHaveLength(0)
    await expect(canvas.getByText('已开启')).toBeVisible()
  },
}

/** 跟在标题后面，和 24px 的图标、正文的行高对齐 */
export const BesideHeading: Story = {
  render: () => (
    <div className="flex w-96 flex-col gap-4">
      <div className="flex items-center gap-2">
        <h3 className="text-lg font-medium text-text">两步验证</h3>
        <Badge tone="success">已开启</Badge>
      </div>
      <div className="flex items-center gap-2 text-base text-text">
        <span className="truncate">steve@example.com</span>
        <Badge tone="warning">未验证</Badge>
      </div>
    </div>
  ),
}
