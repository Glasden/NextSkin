import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent } from 'storybook/test'
import { Checkbox } from './checkbox.tsx'

const meta = {
  title: 'Components/Checkbox',
  component: Checkbox,
  args: { children: '记住我', onCheckedChange: fn() },
} satisfies Meta<typeof Checkbox>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  play: async ({ args, canvas }) => {
    const checkbox = canvas.getByRole('checkbox', { name: '记住我' })
    // 点标签文字也能切换
    await userEvent.click(canvas.getByText('记住我'))
    await expect(checkbox).toBeChecked()
    // 空格键切换回来
    await userEvent.keyboard(' ')
    await expect(checkbox).not.toBeChecked()
    await expect(args.onCheckedChange).toHaveBeenCalledTimes(2)
    checkbox.blur()
  },
}

export const States: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <Checkbox>未选中</Checkbox>
      <Checkbox defaultChecked>已选中</Checkbox>
      <Checkbox indeterminate>部分选中</Checkbox>
      <Checkbox disabled>禁用</Checkbox>
      <Checkbox disabled defaultChecked>
        禁用且已选中
      </Checkbox>
    </div>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('checkbox', { name: '部分选中' })).toHaveAttribute('aria-checked', 'mixed')
    const disabled = canvas.getByRole('checkbox', { name: '禁用' })
    await userEvent.click(disabled)
    await expect(disabled).not.toBeChecked()
  },
}

export const LongLabel: Story = {
  args: { children: '我已阅读并同意用户协议和隐私政策。上传的材质如果侵犯他人权利，站点可以删除并扣除相应积分。' },
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
}
