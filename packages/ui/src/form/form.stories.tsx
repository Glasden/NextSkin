import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, waitFor } from 'storybook/test'
import { Button } from '../button/button.tsx'
import { Field } from '../field/field.tsx'
import { Input } from '../input/input.tsx'
import { Form } from './form.tsx'

const meta = {
  title: 'Components/Form',
  component: Form,
  args: { onFormSubmit: fn() },
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Form>

export default meta
type Story = StoryObj<typeof meta>

export const NativeValidation: Story = {
  name: 'Native validation',
  render: (args) => (
    <Form {...args}>
      <Field label="邮箱" name="email">
        <Input type="email" required />
      </Field>
      <Button type="submit" variant="primary">
        发送验证邮件
      </Button>
    </Form>
  ),
  // 约束校验不通过时不提交，提示显示在输入框下方，焦点移到输入框
  play: async ({ args, canvas }) => {
    await userEvent.click(canvas.getByRole('button', { name: '发送验证邮件' }))
    const input = canvas.getByRole<HTMLInputElement>('textbox', { name: '邮箱' })
    await expect(args.onFormSubmit).not.toHaveBeenCalled()
    await expect(input).toHaveAttribute('aria-invalid', 'true')
    await expect(input).toHaveFocus()
    await expect(input).toHaveAccessibleDescription(input.validationMessage)
    await userEvent.type(input, 'steve@example.com')
    await userEvent.click(canvas.getByRole('button', { name: '发送验证邮件' }))
    await expect(args.onFormSubmit).toHaveBeenCalledOnce()
    await expect(input).not.toHaveAttribute('aria-invalid')
    // 模拟的点击会让按钮显示焦点框，真实的鼠标点击不会
    ;(document.activeElement as HTMLElement | null)?.blur()
  },
}

export const ServerErrors: Story = {
  name: 'Server errors',
  render: (args) => (
    <Form {...args} errors={{ player: '这个角色名已被占用，换一个试试' }}>
      <Field label="角色名" name="player">
        <Input defaultValue="Notch" />
      </Field>
      <Button type="submit" variant="primary">
        添加角色
      </Button>
    </Form>
  ),
  // 服务端按字段名返回的错误显示在对应的 Field 下方；改了值就清掉
  play: async ({ canvas }) => {
    const input = canvas.getByRole('textbox', { name: '角色名' })
    await expect(input).toHaveAccessibleDescription('这个角色名已被占用，换一个试试')
    await expect(input).toHaveAttribute('aria-invalid', 'true')
  },
}

export const ClearsOnChange: Story = {
  ...ServerErrors,
  name: 'Clears on change',
  play: async ({ canvas }) => {
    const input = canvas.getByRole('textbox', { name: '角色名' })
    await userEvent.type(input, '_2')
    await expect(input).not.toHaveAttribute('aria-invalid')
    // Base UI 等退出动画结束再移除错误信息
    await waitFor(() => expect(canvas.queryByText('这个角色名已被占用，换一个试试')).toBeNull())
    input.blur()
  },
}
