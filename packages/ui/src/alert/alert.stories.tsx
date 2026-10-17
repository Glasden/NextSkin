import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect } from 'storybook/test'
import { Alert } from './alert.tsx'

const meta = {
  title: 'Components/Alert',
  component: Alert,
  args: { children: null },
  decorators: [
    (Story) => (
      <div className="w-120">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Alert>

export default meta
type Story = StoryObj<typeof meta>

export const Tones: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <Alert title="外置登录地址">在启动器里填写本站地址，即可用站点账号进入服务器。</Alert>
      <Alert tone="success" title="邮箱已验证">
        现在可以上传材质了。
      </Alert>
      <Alert tone="warning" title="积分不足">
        上传这个材质需要 20 积分，你还有 12 积分。每日签到可以获得积分。
      </Alert>
      <Alert tone="danger" title="登录失败">
        邮箱或密码不对。再试一次，或者找回密码。
      </Alert>
    </div>
  ),
  // 警告和错误需要读屏软件立即读出，其余的不打断
  play: async ({ canvas }) => {
    await expect(canvas.getAllByRole('alert')).toHaveLength(2)
    await expect(canvas.getAllByRole('status')).toHaveLength(2)
  },
}

export const WithoutTitle: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <Alert>这个角色还没有设置皮肤。</Alert>
      <Alert tone="danger">
        材质文件不是有效的 PNG 图片。请上传 64×32 或 64×64 的皮肤，或 64×32 的披风，高清材质需按比例放大。
      </Alert>
    </div>
  ),
}
