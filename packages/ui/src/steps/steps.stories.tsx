import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, within } from 'storybook/test'
import { ProgressBar } from '../progress-bar/progress-bar.tsx'
import { Steps } from './steps.tsx'

const wizard = [
  { label: '旧站的 .env' },
  { label: '连接和路径' },
  { label: '试跑' },
  { label: '确认' },
  { label: '导入' },
  { label: '完成' },
]

const meta = {
  title: 'Components/Steps',
  component: Steps,
  args: { label: '导入步骤', items: wizard, current: 2, completeLabel: '已完成' },
  decorators: [
    (Story) => (
      <div className="w-180">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Steps>

export default meta
type Story = StoryObj<typeof meta>

export const Horizontal: Story = {
  play: async ({ canvas }) => {
    const list = canvas.getByRole('list', { name: '导入步骤' })
    const items = within(list).getAllByRole('listitem')
    await expect(items).toHaveLength(6)
    await expect(items[2]).toHaveAttribute('aria-current', 'step')
    // 完成的步骤给读屏软件读出状态，没走到的不读
    await expect(items[0]).toHaveTextContent('旧站的 .env（已完成）')
    await expect(items[3]).toHaveTextContent(/^4?确认$/)
  },
}

export const FirstStep: Story = {
  args: { current: 0 },
}

export const AllComplete: Story = {
  args: { current: wizard.length },
  play: async ({ canvas }) => {
    const items = within(canvas.getByRole('list', { name: '导入步骤' })).getAllByRole('listitem')
    for (const item of items) await expect(item).not.toHaveAttribute('aria-current')
  },
}

/** 容器窄于 576px（手机）：只显示当前这一步和一排小方块；读屏软件仍然读完整的列表 */
export const Narrow: Story = {
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvas }) => {
    await expect(within(canvas.getByRole('list', { name: '导入步骤' })).getAllByRole('listitem')).toHaveLength(6)
  },
}

/** 竖排：带说明的阶段列表，例如导入的进度。当前阶段的说明里放进度条 */
export const Vertical: Story = {
  args: {
    label: '导入进度',
    orientation: 'vertical',
    current: 2,
    items: [
      { label: '连接旧库' },
      { label: '用户', description: '5,000 行' },
      {
        label: '材质',
        description: <ProgressBar label="已处理" value={1234} max={3200} valueText="1,234 / 3,200 行" />,
      },
      { label: '角色' },
      { label: '衣柜和举报' },
      { label: '提交' },
    ],
  },
  decorators: [
    (Story) => (
      <div className="w-120">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvas }) => {
    const items = within(canvas.getByRole('list', { name: '导入进度' })).getAllByRole('listitem')
    await expect(items[2]).toHaveAttribute('aria-current', 'step')
    await expect(within(items[2]!).getByRole('progressbar', { name: '已处理' })).toBeVisible()
  },
}
