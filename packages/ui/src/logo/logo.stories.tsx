import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect } from 'storybook/test'
import { Logo } from './logo.tsx'

const meta = {
  title: 'Components/Logo',
  component: Logo,
  args: { name: 'NextSkin' },
} satisfies Meta<typeof Logo>

export default meta
type Story = StoryObj<typeof meta>

export const Sizes: Story = {
  render: () => (
    <div className="flex flex-col items-start gap-6">
      <Logo name="NextSkin" />
      <Logo name="NextSkin" size="sm" />
      <Logo name="像素方块皮肤站" />
      <Logo name="像素方块皮肤站" size="sm" />
    </div>
  ),
  // 展开图只是装饰，读屏软件只读站点名
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll('[aria-hidden]')).toHaveLength(4)
  },
}
