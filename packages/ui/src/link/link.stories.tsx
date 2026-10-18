import type { Meta, StoryObj } from '@storybook/react-vite'
import type { ComponentProps } from 'react'
import { expect } from 'storybook/test'
import { Link } from './link.tsx'

const meta = {
  title: 'Components/Link',
  component: Link,
  args: { href: '#', children: '忘记密码' },
} satisfies Meta<typeof Link>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const InText: Story = {
  name: 'In text',
  render: () => (
    <p className="w-80 text-base text-text">
      还没有账号？<Link href="#register">注册一个</Link>，然后在启动器里使用<Link href="#yggdrasil">外置登录</Link>。
    </p>
  ),
}

/** 模拟框架的链接组件（例如 next/link） */
function RouterLink(props: ComponentProps<'a'>) {
  return <a data-router {...props} />
}

export const CustomElement: Story = {
  name: 'Custom element',
  render: () => <Link render={<RouterLink href="#forgot" />}>忘记密码</Link>,
  // render 换成别的组件后，样式和子元素照样合并上去
  play: async ({ canvas }) => {
    const link = canvas.getByRole('link', { name: '忘记密码' })
    await expect(link).toHaveAttribute('data-router')
    await expect(link).toHaveAttribute('href', '#forgot')
    await expect(link.className).toContain('underline')
  },
}

/** 页脚这种成组的一列链接用 quiet：正文色，悬停时才出下划线 */
export const Quiet: Story = {
  render: () => (
    <ul className="flex flex-col gap-2 text-sm">
      {['皮肤库', '上传材质', '用户中心'].map((label) => (
        <li key={label}>
          <Link tone="quiet" href={`#${label}`}>
            {label}
          </Link>
        </li>
      ))}
    </ul>
  ),
  play: async ({ canvas }) => {
    const link = canvas.getByRole('link', { name: '皮肤库' })
    await expect(getComputedStyle(link).textDecorationLine).toBe('none')
  },
}
