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
