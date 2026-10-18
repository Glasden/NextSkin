import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent } from 'storybook/test'
import { Switch } from './switch.tsx'

const onCheckedChange = fn()

const meta = {
  title: 'Components/Switch',
  component: Switch,
  args: { children: '显示外层', defaultChecked: true, onCheckedChange },
} satisfies Meta<typeof Switch>

export default meta
type Story = StoryObj<typeof meta>

/** 点开关或标签都会切换，立即生效 */
export const Default: Story = {
  play: async ({ canvas }) => {
    const control = canvas.getByRole('switch', { name: '显示外层' })
    await expect(control).toBeChecked()
    await userEvent.click(canvas.getByText('显示外层'))
    await expect(control).not.toBeChecked()
    await expect(onCheckedChange).toHaveBeenLastCalledWith(false, expect.anything())
    await userEvent.click(control)
    await expect(control).toBeChecked()
    // 结束前移开焦点：模拟点击留下的焦点框，真实的鼠标点击不会有
    control.blur()
  },
}

export const States: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <Switch defaultChecked>打开</Switch>
      <Switch>关闭</Switch>
      <Switch disabled defaultChecked>
        已禁用，打开
      </Switch>
      <Switch disabled>已禁用，关闭</Switch>
    </div>
  ),
}

/** 键盘聚焦时显示焦点框，空格切换 */
export const Focused: Story = {
  args: { defaultChecked: false },
  play: async ({ canvas }) => {
    await userEvent.tab()
    const control = canvas.getByRole('switch', { name: '显示外层' })
    await expect(control).toHaveFocus()
    await userEvent.keyboard(' ')
    await expect(control).toBeChecked()
  },
}
