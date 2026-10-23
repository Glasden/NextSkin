import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect } from 'storybook/test'
import { PasswordMeter } from './password-meter.tsx'

const meta = {
  title: 'Components/PasswordMeter',
  component: PasswordMeter,
  args: { level: 2, label: '强', ariaLabel: '密码强度：强' },
} satisfies Meta<typeof PasswordMeter>

export default meta
type Story = StoryObj<typeof meta>

export const Levels: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <PasswordMeter level={0} label="弱" ariaLabel="密码强度：弱" />
      <PasswordMeter level={1} label="一般" ariaLabel="密码强度：一般" />
      <PasswordMeter level={2} label="强" ariaLabel="密码强度：强" />
      <PasswordMeter level={3} label="很强" ariaLabel="密码强度：很强" />
    </div>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getAllByRole('status')).toHaveLength(4)
    await expect(canvas.getByText('很强')).toBeVisible()
    // 读屏软件读到的是完整说法，不是孤零零的档位
    await expect(canvas.getByRole('status', { name: '密码强度：弱' })).toBeVisible()
  },
}

/** 还没有输入时不显示：注册页只在用户输入了内容之后才放 */
export const Empty: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <div data-testid="placeholder" />
      <PasswordMeter level={null} label="弱" ariaLabel="密码强度：弱" />
    </div>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.queryAllByRole('status')).toHaveLength(0)
    await expect(canvas.getByTestId('placeholder')).toBeVisible()
  },
}
