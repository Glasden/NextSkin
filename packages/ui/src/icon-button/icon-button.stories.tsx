import type { Meta, StoryObj } from '@storybook/react-vite'
import { Copy } from 'pixelarticons/react/Copy.js'
import { Pencil } from 'pixelarticons/react/Pencil.js'
import { Trash } from 'pixelarticons/react/Trash.js'
import { expect, fn, screen, userEvent, waitFor } from 'storybook/test'
import { IconButton } from './icon-button.tsx'

const meta = {
  title: 'Components/IconButton',
  component: IconButton,
  // 提示渲染在 body 下、按视口定位，截图截整个视口
  tags: ['screenshot-viewport'],
  args: { label: '复制 UUID', children: <Copy />, onClick: fn() },
  decorators: [
    (Story) => (
      <div className="p-12">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof IconButton>

export default meta
type Story = StoryObj<typeof meta>

/** 键盘聚焦时显示提示和焦点框；按钮的名称就是提示的文字 */
export const WithTooltip: Story = {
  name: 'With tooltip',
  play: async ({ args, canvas }) => {
    const button = canvas.getByRole('button', { name: '复制 UUID' })
    await userEvent.tab()
    await expect(button).toHaveFocus()
    await waitFor(() => expect(screen.getByText('复制 UUID', { selector: '[data-open]' })).toBeVisible(), {
      timeout: 3000,
    })
    await userEvent.keyboard('{Enter}')
    await expect(args.onClick).toHaveBeenCalledOnce()
    // 按下按钮会关掉提示；重新聚焦，截图里留下提示
    await userEvent.tab({ shift: true })
    await userEvent.tab()
    await waitFor(() => expect(screen.getByText('复制 UUID', { selector: '[data-open]' })).toBeVisible(), {
      timeout: 3000,
    })
  },
}

export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <IconButton label="改名" size="sm">
        <Pencil />
      </IconButton>
      <IconButton label="删除">
        <Trash />
      </IconButton>
      <IconButton label="复制 UUID" disabled>
        <Copy />
      </IconButton>
    </div>
  ),
}
