import type { Meta, StoryObj } from '@storybook/react-vite'
import { Upload } from 'pixelarticons/react/Upload.js'
import { expect, userEvent } from 'storybook/test'
import { ButtonLink } from './button-link.tsx'

const meta = {
  title: 'Components/ButtonLink',
  component: ButtonLink,
  args: { children: '注册', href: '#sign-up' },
} satisfies Meta<typeof ButtonLink>

export default meta
type Story = StoryObj<typeof meta>

/** 首页主视觉的一对入口：主要的一个用强调色，另一个是次要的样子；两种尺寸 */
export const Variants: Story = {
  render: () => (
    <div className="flex flex-col items-start gap-4">
      <div className="flex flex-wrap gap-3">
        <ButtonLink variant="primary" size="lg" href="#upload">
          <Upload aria-hidden />
          上传材质
        </ButtonLink>
        <ButtonLink size="lg" href="#skinlib">
          浏览皮肤库
        </ButtonLink>
      </div>
      <div className="flex flex-wrap gap-3">
        <ButtonLink variant="primary" href="#sign-up">
          注册
        </ButtonLink>
        <ButtonLink href="#sign-in">登录</ButtonLink>
      </div>
    </div>
  ),
  play: async ({ canvas }) => {
    // 是链接，不是按钮：读屏软件报“链接”，中键能在新标签页打开
    const link = canvas.getByRole('link', { name: '上传材质' })
    await expect(link).toHaveAttribute('href', '#upload')
    await expect(canvas.queryAllByRole('button')).toHaveLength(0)
    await userEvent.tab()
    await expect(link).toHaveFocus()
    await expect(getComputedStyle(link).outlineStyle).toBe('solid')
    link.blur()
  },
}
