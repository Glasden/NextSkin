import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent } from 'storybook/test'
import { Button } from '../button/button.tsx'
import { Input } from '../input/input.tsx'
import { Form } from '../form/form.tsx'
import { Field } from './field.tsx'
import { RequiredMessageProvider } from './required-message.tsx'

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

export const RequiredMessage: Story = {
  render: () => (
    // 必填的提示由 RequiredMessageProvider 按站点语言给一次，调用点什么都不用传。
    // 校验时机默认是表单提交，用 Form 包裹才能触发
    <RequiredMessageProvider message="请填写这一项。">
      <Form onSubmit={(e) => e.preventDefault()}>
        <Field label="邮箱">
          <Input type="email" name="email" required placeholder="you@example.com" />
        </Field>
        <Field label="昵称">
          <Input name="nickname" placeholder="可以不填" />
        </Field>
        <Button type="submit">提交</Button>
      </Form>
    </RequiredMessageProvider>
  ),
  play: async ({ canvas }) => {
    const email = canvas.getByRole('textbox', { name: '邮箱' })
    // 没填就提交，显示站点给的文案，不是浏览器语言的消息
    await userEvent.click(canvas.getByRole('button', { name: '提交' }))
    await expect(canvas.getByText('请填写这一项。')).toBeInTheDocument()
    await expect(email).toHaveAttribute('aria-invalid', 'true')
    await expect(email).toHaveAccessibleDescription('请填写这一项。')
    // 不是必填的控件留空是合法的，不会被这条提示挡住
    await expect(canvas.getByRole('textbox', { name: '昵称' })).not.toHaveAttribute('aria-invalid', 'true')
    // 提交后焦点落在第一个不通过的控件上；真实的鼠标操作不会留下焦点框，截图前移开
    email.blur()
  },
}
