import { DIAMOND } from '@nextskin/theme'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, fn, userEvent } from 'storybook/test'
import { cobalt, magenta, previewCss } from '../theme-card/fixtures.ts'
import { ThemePicker } from './theme-picker.tsx'

const meta = {
  title: 'Components/ThemePicker',
  component: ThemePicker,
  args: { options: [], 'aria-label': '主题' },
  decorators: [
    (Story) => (
      <>
        <style>{previewCss}</style>
        <Story />
      </>
    ),
  ],
} satisfies Meta<typeof ThemePicker>

export default meta
type Story = StoryObj<typeof meta>

const onValueChange = fn()

/**
 * 用户中心挑主题：第一项是跟随站点默认（小样画站点默认的那套），下面每套启用的主题一张。
 * 点一下就选中，页面随即保存、整页换上
 */
export const Default: Story = {
  render: function Render() {
    const [value, setValue] = useState('default')
    return (
      <div className="w-180">
        <ThemePicker
          aria-label="主题"
          value={value}
          onValueChange={(next) => {
            setValue(next)
            onValueChange(next)
          }}
          options={[
            { value: 'default', theme: DIAMOND, name: '跟随站点默认', description: '现在是钻石青' },
            { value: DIAMOND, theme: DIAMOND, name: '钻石青', description: '内置' },
            { value: cobalt, theme: cobalt, name: '钴蓝', description: '更多配色' },
            { value: magenta, theme: magenta, name: '洋红', description: '更多配色' },
          ]}
        />
      </div>
    )
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('radio', { name: '跟随站点默认' })).toBeChecked()
    await expect(canvas.getByRole('radio', { name: '跟随站点默认' })).toHaveAccessibleDescription('现在是钻石青')
    await userEvent.click(canvas.getByRole('radio', { name: '钴蓝' }))
    await expect(onValueChange).toHaveBeenLastCalledWith(cobalt)
    await expect(canvas.getByRole('radio', { name: '钴蓝' })).toBeChecked()
    await userEvent.keyboard('{ArrowRight}')
    await expect(canvas.getByRole('radio', { name: '洋红' })).toBeChecked()
    ;(document.activeElement as HTMLElement | null)?.blur()
  },
}
