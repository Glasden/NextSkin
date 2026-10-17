import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent } from 'storybook/test'
import { Button } from '../button/button.tsx'
import { Field } from '../field/field.tsx'
import { Input } from './input.tsx'

const meta = {
  title: 'Components/Input',
  component: Input,
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Input>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Field label="角色名">
      <Input name="player" placeholder="3–16 个字母、数字或下划线" />
    </Field>
  ),
  play: async ({ canvas }) => {
    const input = canvas.getByRole('textbox', { name: '角色名' })
    await userEvent.type(input, 'Steve_01')
    await expect(input).toHaveValue('Steve_01')
    input.blur()
  },
}

// 同一行里的输入框和按钮取相同的尺寸
export const Sizes: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      {(['sm', 'md', 'lg'] as const).map((size) => (
        <div key={size} className="flex items-center gap-2">
          <Input size={size} aria-label={`搜索（${size}）`} placeholder="搜索材质" />
          <Button size={size}>搜索</Button>
        </div>
      ))}
    </div>
  ),
}

export const Disabled: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <Input aria-label="已禁用" disabled defaultValue="不能修改" />
      <Input aria-label="已禁用，空" disabled placeholder="占位文字" />
    </div>
  ),
}
