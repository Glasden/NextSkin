import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, fn, userEvent } from 'storybook/test'
import { fixture, raiseSettled, type FixtureName } from '../skin-figure/fixtures.ts'
import { SkinFigure } from '../skin-figure/skin-figure.tsx'
import { TexturePicker } from './texture-picker.tsx'

const option = (value: string, name: string, texture: FixtureName) => ({
  value,
  name,
  figure: <SkinFigure {...fixture(texture)} scale={3} view="front" alt={name} />,
})

const skins = [
  option('12', '上学穿', 'hatsune_miku'),
  option('7', 'Haka', 'haka'),
  option('31', '红金装甲（高清）', 'ironman_hd'),
  option('2', '一个很长很长、在卡片里放不下的名字', 'sethbling'),
  option('5', '默认', 'default-skin'),
]

const onValueChange = fn()

const meta = {
  title: 'Components/TexturePicker',
  component: TexturePicker,
  args: { options: skins, 'aria-label': '选择皮肤', onValueChange },
  decorators: [
    (Story) => (
      <div className="w-100">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TexturePicker>

export default meta
type Story = StoryObj<typeof meta>

/** 给角色换皮肤时从衣柜里挑一件。点击或方向键选中，选中的有加粗边框和勾选角标 */
export const Default: Story = {
  render: function Render(args) {
    const [value, setValue] = useState<string | null>(null)
    return (
      <TexturePicker
        {...args}
        value={value}
        onValueChange={(next) => {
          setValue(next)
          args.onValueChange?.(next)
        }}
      />
    )
  },
  play: async ({ canvas, canvasElement }) => {
    const group = canvas.getByRole('radiogroup', { name: '选择皮肤' })
    await expect(canvas.getAllByRole('radio')).toHaveLength(5)
    await expect(canvas.queryByRole('radio', { checked: true })).toBeNull()
    await userEvent.click(canvas.getByRole('radio', { name: 'Haka' }))
    await expect(onValueChange).toHaveBeenLastCalledWith('7')
    await expect(canvas.getByRole('radio', { name: 'Haka' })).toBeChecked()
    await userEvent.keyboard('{ArrowRight}')
    await expect(canvas.getByRole('radio', { name: '红金装甲（高清）' })).toBeChecked()
    await expect(onValueChange).toHaveBeenLastCalledWith('31')
    ;(document.activeElement as HTMLElement | null)?.blur()
    await expect(group).toBeVisible()
    await raiseSettled(canvasElement)
  },
}

/** 打开时选中角色正在用的那一件 */
export const Selected: Story = {
  args: { defaultValue: '12' },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('radio', { name: '上学穿' })).toBeChecked()
    await raiseSettled(canvasElement)
  },
}

/** 披风 */
export const Capes: Story = {
  args: {
    'aria-label': '选择披风',
    options: [option('40', 'Mojang 披风', 'mojang_cape'), option('41', '旧版披风', 'legacy_cape')],
    defaultValue: '41',
  },
}

/** 键盘聚焦时的焦点框 */
export const Focused: Story = {
  args: { defaultValue: '12' },
  play: async ({ canvas, canvasElement }) => {
    await userEvent.tab()
    await expect(canvas.getByRole('radio', { name: '上学穿' })).toHaveFocus()
    await raiseSettled(canvasElement)
  },
}
