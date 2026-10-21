import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, fn, userEvent } from 'storybook/test'
import { PlayerHead } from '../player-head/player-head.tsx'
import { headFixture } from '../skin-figure/fixtures.ts'
import { PlayerPicker } from './player-picker.tsx'

const players = [
  { value: '3', name: 'Miku', head: <PlayerHead {...headFixture('hatsune_miku')} size={32} alt="" /> },
  {
    value: '8',
    name: 'Haka',
    head: <PlayerHead {...headFixture('haka')} size={32} alt="" />,
    description: '上次进服：昨天',
  },
  {
    value: '15',
    name: 'IronMan_HD_With_A_Long_Name',
    head: <PlayerHead {...headFixture('ironman_hd')} size={32} alt="" />,
    description: '一行放不下的补充说明会在末尾截断，不会把这一行撑高',
  },
  { value: '21', name: 'NoSkinYet', head: <PlayerHead fallback="blank" size={32} alt="" />, description: '还没有皮肤' },
]

const onValueChange = fn()

const meta = {
  title: 'Components/PlayerPicker',
  component: PlayerPicker,
  args: { options: players, 'aria-label': '选择角色', onValueChange },
  decorators: [
    (Story) => (
      <div className="w-90">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PlayerPicker>

export default meta
type Story = StoryObj<typeof meta>

/** 启动器授权时选择用哪个角色进服。点击或方向键选中，选中的有加粗边框，前面的方框打勾 */
export const Default: Story = {
  render: function Render(args) {
    const [value, setValue] = useState<string | null>(null)
    return (
      <PlayerPicker
        {...args}
        value={value}
        onValueChange={(next) => {
          setValue(next)
          args.onValueChange?.(next)
        }}
      />
    )
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('radiogroup', { name: '选择角色' })).toBeVisible()
    await expect(canvas.getAllByRole('radio')).toHaveLength(4)
    await expect(canvas.queryByRole('radio', { checked: true })).toBeNull()
    await userEvent.click(canvas.getByRole('radio', { name: 'Haka' }))
    await expect(onValueChange).toHaveBeenLastCalledWith('8')
    await expect(canvas.getByRole('radio', { name: 'Haka' })).toBeChecked()
    await expect(canvas.getByRole('radio', { name: 'Haka' })).toHaveAccessibleDescription('上次进服：昨天')
    await userEvent.keyboard('{ArrowDown}')
    await expect(canvas.getByRole('radio', { name: 'IronMan_HD_With_A_Long_Name' })).toBeChecked()
    await expect(onValueChange).toHaveBeenLastCalledWith('15')
    ;(document.activeElement as HTMLElement | null)?.blur()
  },
}

/** 打开时选中上次授权用的角色 */
export const Selected: Story = {
  args: { defaultValue: '3' },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('radio', { name: 'Miku' })).toBeChecked()
  },
}

/** 提交中：整组不可选 */
export const Disabled: Story = {
  args: { defaultValue: '8', disabled: true },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('radio', { name: 'Haka' })).toHaveAttribute('aria-disabled', 'true')
  },
}

/** 键盘聚焦时的焦点框 */
export const Focused: Story = {
  args: { defaultValue: '3' },
  play: async ({ canvas }) => {
    await userEvent.tab()
    await expect(canvas.getByRole('radio', { name: 'Miku' })).toHaveFocus()
  },
}
