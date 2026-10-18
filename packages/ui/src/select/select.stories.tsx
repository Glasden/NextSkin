import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, screen, userEvent, waitFor } from 'storybook/test'
import { Field } from '../field/field.tsx'
import { Select } from './select.tsx'

type Locale = 'zh-CN' | 'en'
const locales = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: 'English' },
] as const satisfies readonly { value: Locale; label: string }[]

const meta = {
  title: 'Components/Select',
  component: Select<Locale>,
  args: { options: locales, defaultValue: 'zh-CN', onValueChange: fn() },
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Select<Locale>>

export default meta
type Story = StoryObj<typeof meta>

/** 放在 Field 里：标签是 div，点标签聚焦触发器但不打开；鼠标选一项后触发器显示它的文字 */
export const Default: Story = {
  render: (args) => (
    <Field label="界面语言" nativeLabel={false} description="邮件也按这个语言发送">
      <Select {...args} />
    </Field>
  ),
  play: async ({ args, canvas }) => {
    const trigger = canvas.getByRole('combobox', { name: '界面语言' })
    await expect(trigger).toHaveTextContent('简体中文')
    await expect(trigger).toHaveAccessibleDescription('邮件也按这个语言发送')
    await userEvent.click(trigger)
    await userEvent.click(await screen.findByRole('option', { name: 'English' }))
    await expect(args.onValueChange).toHaveBeenCalledOnce()
    await expect(args.onValueChange).toHaveBeenCalledWith('en')
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    await expect(trigger).toHaveTextContent('English')
    await expect(trigger).toHaveFocus()
    // 模拟的点击会留下焦点框，真实的鼠标点击不会
    trigger.blur()
  },
}

/** 键盘打开，方向键移动，回车选中。截图里列表保持打开，选中项打勾 */
export const Open: Story = {
  // 列表渲染在 body 下、按视口定位，截图截整个视口
  tags: ['screenshot-viewport'],
  args: { 'aria-label': '界面语言' },
  play: async ({ args, canvas }) => {
    const trigger = canvas.getByRole('combobox', { name: '界面语言' })
    await userEvent.tab()
    await expect(trigger).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    await screen.findByRole('listbox')
    await waitFor(() => expect(screen.getByRole('option', { name: '简体中文' })).toHaveFocus())
    await userEvent.keyboard('{ArrowDown}{Enter}')
    await expect(args.onValueChange).toHaveBeenCalledOnce()
    await expect(args.onValueChange).toHaveBeenCalledWith('en')
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    await userEvent.keyboard('{ArrowDown}')
    await expect(await screen.findByRole('option', { name: 'English' })).toHaveAttribute('aria-selected', 'true')
  },
}

export const Sizes: Story = {
  render: (args) => (
    <div className="flex flex-col gap-4">
      {(['sm', 'md', 'lg'] as const).map((size) => (
        <Select key={size} {...args} size={size} aria-label={`尺寸 ${size}`} />
      ))}
    </div>
  ),
}

/** Field 的禁用和错误信息同样作用在选择框上 */
export const States: Story = {
  render: (args) => (
    <div className="flex flex-col gap-4">
      <Field label="禁用" nativeLabel={false} disabled>
        <Select {...args} />
      </Field>
      <Field label="界面语言" nativeLabel={false} error="请选择一种界面语言">
        <Select {...args} />
      </Field>
    </div>
  ),
  play: async ({ args, canvas }) => {
    const disabled = canvas.getByRole('combobox', { name: '禁用' })
    await expect(disabled).toHaveAttribute('data-disabled')
    await userEvent.click(disabled)
    await expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    await expect(args.onValueChange).not.toHaveBeenCalled()
    const invalid = canvas.getByRole('combobox', { name: '界面语言' })
    await expect(invalid).toHaveAttribute('aria-invalid', 'true')
    await expect(invalid).toHaveAccessibleDescription('请选择一种界面语言')
  },
}
