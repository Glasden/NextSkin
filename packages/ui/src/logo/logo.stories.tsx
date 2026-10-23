import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent } from 'storybook/test'
import { uploadedLogo } from './fixtures.ts'
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

export const AsLink: Story = {
  name: 'As link',
  // 页头里链接到首页；story 里用 <a> 代替框架的链接组件
  render: () => <Logo name="NextSkin" render={<a href="#home" />} />,
  play: async ({ canvas }) => {
    const link = canvas.getByRole('link', { name: 'NextSkin' })
    await expect(link).toHaveAttribute('href', '#home')
    await userEvent.tab()
    await expect(link).toHaveFocus()
    // 键盘聚焦时有焦点框（DESIGN.md §9）
    await expect(getComputedStyle(link).outlineStyle).toBe('solid')
    link.blur()
  },
}

/**
 * 页头里的标志：md 以下只显示图形，站点名留给读屏软件；更宽时站点名放不下就截断。
 * 截图的视口比 md 宽，这里看到的是截断
 */
export const Compact: Story = {
  // 和页头里一样放在 flex 容器里：截断靠它把标志压窄
  render: () => (
    <div className="flex w-48">
      <Logo name="像素方块 Minecraft 皮肤站" compact render={<a href="#home" />} />
    </div>
  ),
  play: async ({ canvas }) => {
    // 不管哪种宽度，链接的名称都是完整的站点名
    await expect(canvas.getByRole('link', { name: '像素方块 Minecraft 皮肤站' })).toBeVisible()
  },
}

/** 站长上传了标志（ADR-0042）：换掉像素图形，尺寸不变，站点名照旧 */
export const WithImage: Story = {
  name: 'With image',
  render: () => (
    <div className="flex flex-col items-start gap-6">
      <Logo name="NextSkin" image={uploadedLogo} />
      <Logo name="NextSkin" size="sm" image={uploadedLogo} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const images = [...canvasElement.querySelectorAll('img')]
    await expect(images.map((image) => image.width)).toEqual([32, 24])
    await expect(images.every((image) => image.alt === '')).toBe(true)
  },
}
