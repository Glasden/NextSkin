import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent } from 'storybook/test'
import { Field } from '../field/field.tsx'
import { Textarea } from './textarea.tsx'

const meta = {
  title: 'Components/Textarea',
  component: Textarea,
  decorators: [
    (Story) => (
      <div className="w-96">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Textarea>

export default meta
type Story = StoryObj<typeof meta>

/** 材质描述：右下角显示已输入的字数和上限 */
export const Default: Story = {
  render: () => (
    <Field label="描述" description="选填。写写灵感来源、适合的场合">
      <Textarea name="description" maxLength={2000} placeholder="这件皮肤的故事" />
    </Field>
  ),
  play: async ({ canvas }) => {
    const textarea = canvas.getByRole('textbox', { name: '描述' })
    await userEvent.type(textarea, '樱花季限定。{enter}袖口的花瓣是半透明的。')
    await expect(textarea).toHaveValue('樱花季限定。\n袖口的花瓣是半透明的。')
    await expect(canvas.getByText('18 / 2000')).toBeVisible()
    textarea.blur()
  },
}

/** 到了上限，浏览器不让再输入 */
export const AtLimit: Story = {
  render: () => (
    <Field label="举报理由">
      <Textarea name="reason" maxLength={20} rows={2} defaultValue="这张皮肤抄袭了别人的作品，原作在" />
    </Field>
  ),
  play: async ({ canvas }) => {
    const textarea = canvas.getByRole('textbox', { name: '举报理由' })
    await userEvent.type(textarea, '论坛的第三页。')
    await expect(textarea).toHaveValue('这张皮肤抄袭了别人的作品，原作在论坛的第')
    await expect(canvas.getByText('20 / 20')).toBeVisible()
    textarea.blur()
  },
}

export const States: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <Field label="错误" error="描述最多 2000 个字符，请删减后重试。">
        <Textarea defaultValue="……" rows={2} />
      </Field>
      <Field label="已禁用" disabled>
        <Textarea defaultValue="不能修改" rows={2} />
      </Field>
    </div>
  ),
}
