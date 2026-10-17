import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, screen, userEvent, waitFor } from 'storybook/test'
import { Button } from '../button/button.tsx'
import { Tooltip } from './tooltip.tsx'

const meta = {
  title: 'Components/Tooltip',
  component: Tooltip,
  // 提示渲染在 body 下、按视口定位，截图截整个视口
  tags: ['screenshot-viewport'],
  args: {
    content: '玩家在启动器里填这个地址',
    children: <Button>复制外置登录地址</Button>,
  },
  decorators: [
    (Story) => (
      <div className="p-12">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Tooltip>

export default meta
type Story = StoryObj<typeof meta>

/** 鼠标停留或键盘聚焦时出现。触屏设备上不显示，所以只放补充说明 */
export const Open: Story = {
  play: async ({ canvas }) => {
    await userEvent.tab()
    await expect(canvas.getByRole('button', { name: '复制外置登录地址' })).toHaveFocus()
    // 出现时有阶跃的淡入；并行跑测试时可能超过 waitFor 默认的 1 秒
    await waitFor(() => expect(screen.getByText('玩家在启动器里填这个地址')).toBeVisible(), { timeout: 3000 })
  },
}
