import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn } from 'storybook/test'
import { CaptchaFrame } from './captcha-frame.tsx'

/** 截图不连外网：用一块假的挂件代替服务商渲染的 iframe */
function FakeWidget() {
  return (
    <div className="flex h-16 w-75 items-center gap-3 border border-border bg-surface px-4 text-sm text-text">
      <span className="size-6 rounded-sm border-2 border-border-strong" />
      确认你是真人
    </div>
  )
}

const meta = {
  title: 'Components/CaptchaFrame',
  component: CaptchaFrame,
  args: {
    status: 'ready',
    label: '人机验证',
    loadingText: '正在加载验证码',
    children: <FakeWidget />,
  },
  decorators: [
    (Story) => (
      <div className="w-100">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CaptchaFrame>

export default meta
type Story = StoryObj<typeof meta>

/** 挂件出来之前占住它的位置 */
export const Loading: Story = {
  args: { status: 'loading' },
  play: async ({ canvas }) => {
    const group = canvas.getByRole('group', { name: '人机验证' })
    await expect(group).toHaveAttribute('aria-busy', 'true')
    await expect(canvas.getByText('正在加载验证码')).toBeVisible()
    // 挂件的容器还在页面上，服务商的脚本要往里面渲染
    await expect(canvas.queryByText('确认你是真人')).not.toBeVisible()
  },
}

export const Ready: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByText('确认你是真人')).toBeVisible()
    await expect(canvas.queryByText('正在加载验证码')).toBeNull()
  },
}

/** 脚本被拦截或网络不通：写明要能访问哪家服务商，给一个重试 */
export const Failed: Story = {
  args: {
    status: 'error',
    error:
      '验证码没有加载出来。本站的验证码由 Cloudflare Turnstile 提供，检查网络能否访问 challenges.cloudflare.com，然后重试。',
    retryLabel: '重新加载',
    onRetry: fn(),
  },
  play: async ({ args, canvas, userEvent }) => {
    await expect(canvas.getByRole('alert')).toHaveTextContent('challenges.cloudflare.com')
    await userEvent.click(canvas.getByRole('button', { name: '重新加载' }))
    await expect(args.onRetry).toHaveBeenCalledOnce()
    // 模拟点击留下的焦点框会出现在截图里（packages/ui/AGENTS.md）
    ;(document.activeElement as HTMLElement | null)?.blur()
  },
}
