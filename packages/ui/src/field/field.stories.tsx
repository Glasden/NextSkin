import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent } from 'storybook/test'
import { Input } from '../input/input.tsx'
import { Field } from './field.tsx'

const meta = {
  title: 'Components/Field',
  component: Field,
  args: { label: '邮箱', children: null },
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Field>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Field label="邮箱" description="用于登录和找回密码，不会公开">
      <Input type="email" name="email" autoComplete="email" placeholder="you@example.com" />
    </Field>
  ),
  play: async ({ canvas }) => {
    // 点标签聚焦输入框；说明文字经 aria-describedby 关联
    await userEvent.click(canvas.getByText('邮箱'))
    const input = canvas.getByRole('textbox', { name: '邮箱' })
    await expect(input).toHaveFocus()
    await expect(input).toHaveAccessibleDescription('用于登录和找回密码，不会公开')
    input.blur()
  },
}

export const WithError: Story = {
  render: () => (
    <Field label="角色名" error="这个角色名已被占用，换一个试试">
      <Input name="player" defaultValue="Notch" />
    </Field>
  ),
  play: async ({ canvas }) => {
    const input = canvas.getByRole('textbox', { name: '角色名' })
    await expect(input).toHaveAttribute('aria-invalid', 'true')
    await expect(input).toHaveAccessibleDescription('这个角色名已被占用，换一个试试')
  },
}

export const Disabled: Story = {
  render: () => (
    <Field label="用户名" description="注册后不能修改" disabled>
      <Input name="username" defaultValue="steve" />
    </Field>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('textbox', { name: '用户名' })).toBeDisabled()
  },
}
