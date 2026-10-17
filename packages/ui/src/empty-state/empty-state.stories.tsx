import type { Meta, StoryObj } from '@storybook/react-vite'
import { Users } from 'pixelarticons/react/Users.js'
import { expect } from 'storybook/test'
import { Button } from '../button/button.tsx'
import { EmptyState } from './empty-state.tsx'

const meta = {
  title: 'Components/EmptyState',
  component: EmptyState,
  args: {
    icon: <Users />,
    title: '你还没有角色',
    description: '角色就是你在游戏里的名字。添加一个角色，就能用外置登录进服务器了。',
    action: <Button variant="primary">添加角色</Button>,
  },
  decorators: [
    (Story) => (
      <div className="w-160">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof EmptyState>

export default meta
type Story = StoryObj<typeof meta>

export const WithAction: Story = {
  name: 'With action',
  play: async ({ canvas }) => {
    await expect(canvas.getByText('你还没有角色')).toBeVisible()
    await expect(canvas.getByRole('button', { name: '添加角色' })).toBeEnabled()
  },
}

/** 没有可做的操作时只说明原因 */
export const WithoutAction: Story = {
  name: 'Without action',
  args: { action: undefined, title: '还没有积分变动', description: undefined },
}
