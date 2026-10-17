import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { Button, type ButtonProps } from './button.tsx'

const meta = {
  title: 'Components/Button',
  component: Button,
  args: { children: '保存', onClick: fn() },
} satisfies Meta<typeof Button>

export default meta
type Story = StoryObj<typeof meta>

const variants = ['primary', 'secondary', 'danger'] as const
const labels: Record<(typeof variants)[number], string> = {
  primary: '上传材质',
  secondary: '取消',
  danger: '删除材质',
}

/** 三种外观排成一行，其余属性相同 */
function Row(props: Omit<ButtonProps, 'variant' | 'children'>) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      {variants.map((variant) => (
        <Button key={variant} {...props} variant={variant}>
          {labels[variant]}
        </Button>
      ))}
    </div>
  )
}

export const Primary: Story = {
  args: { variant: 'primary', children: '上传材质' },
  play: async ({ args, canvas }) => {
    const button = canvas.getByRole('button', { name: '上传材质' })
    await userEvent.click(button)
    await expect(args.onClick).toHaveBeenCalledOnce()
    // 模拟的点击会让按钮显示焦点框，真实的鼠标点击不会；移开焦点，截图保持默认状态
    button.blur()
  },
}

export const Secondary: Story = {
  args: { children: '取消' },
  // 键盘可以聚焦和触发；截图里留下焦点框
  play: async ({ args, canvas }) => {
    await userEvent.tab()
    await expect(canvas.getByRole('button', { name: '取消' })).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    await userEvent.keyboard(' ')
    await expect(args.onClick).toHaveBeenCalledTimes(2)
  },
}

export const Danger: Story = {
  args: { variant: 'danger', children: '删除材质' },
}

export const Sizes: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      {(['sm', 'md', 'lg'] as const).map((size) => (
        <Row key={size} size={size} />
      ))}
    </div>
  ),
}

export const Disabled: Story = {
  render: (args) => <Row disabled onClick={args.onClick} />,
  play: async ({ args, canvasElement }) => {
    const buttons = within(canvasElement).getAllByRole('button')
    for (const button of buttons) {
      await expect(button).toBeDisabled()
      await userEvent.click(button)
    }
    await expect(args.onClick).not.toHaveBeenCalled()
    // 禁用的按钮不在 Tab 顺序里
    await userEvent.tab()
    await expect(document.body).toHaveFocus()
  },
}

export const Loading: Story = {
  render: (args) => <Row loading onClick={args.onClick} />,
  play: async ({ args, canvas }) => {
    const button = canvas.getByRole('button', { name: '上传材质' })
    await expect(button).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(button)
    await userEvent.keyboard('{Enter}')
    await expect(args.onClick).not.toHaveBeenCalled()
    // 和禁用不同，加载中的按钮仍能聚焦：提交完成后焦点还在原处
    ;(document.activeElement as HTMLElement | null)?.blur()
    await userEvent.tab()
    await expect(button).toHaveFocus()
  },
}

export const FullWidth: Story = {
  render: (args) => (
    <div className="flex w-80 flex-col gap-3">
      <Button variant="primary" size="lg" fullWidth onClick={args.onClick}>
        注册
      </Button>
      <Button size="lg" fullWidth onClick={args.onClick}>
        已有账号，去登录
      </Button>
    </div>
  ),
}
