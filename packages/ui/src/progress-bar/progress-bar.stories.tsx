import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect } from 'storybook/test'
import { ProgressBar } from './progress-bar.tsx'

const meta = {
  title: 'Components/ProgressBar',
  component: ProgressBar,
  args: { label: '材质', value: 1234, max: 5000, valueText: '1,234 / 5,000 行' },
  decorators: [
    (Story) => (
      <div className="w-120">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ProgressBar>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  play: async ({ canvas }) => {
    const bar = canvas.getByRole('progressbar', { name: '材质' })
    await expect(bar).toHaveAttribute('aria-valuenow', '1234')
    await expect(bar).toHaveAttribute('aria-valuemax', '5000')
    await expect(bar).toHaveAttribute('aria-valuetext', '1,234 / 5,000 行')
  },
}

/** 按格前进：没有做完就不亮满最后一格 */
export const Values: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <ProgressBar label="连接旧库" value={0} />
      <ProgressBar label="用户" value={12} valueText="12%" />
      <ProgressBar label="角色" value={99} valueText="99%" />
      <ProgressBar label="设置" value={100} valueText="完成" />
    </div>
  ),
  play: async ({ canvas }) => {
    const bars = canvas.getAllByRole('progressbar')
    await expect(bars.map((bar) => bar.getAttribute('aria-valuenow'))).toEqual(['0', '12', '99', '100'])
  },
}

/** 进度未知：方块从左到右依次亮起；截图里是静止的某一帧 */
export const Indeterminate: Story = {
  args: { label: '正在提交', value: null, valueText: undefined },
  play: async ({ canvas }) => {
    const bar = canvas.getByRole('progressbar', { name: '正在提交' })
    await expect(bar).not.toHaveAttribute('aria-valuenow')
    await expect(bar).not.toHaveAttribute('aria-valuemax')
  },
}
