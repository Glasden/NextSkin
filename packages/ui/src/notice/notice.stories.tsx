import type { Meta, StoryObj } from '@storybook/react-vite'
import { ToolCase } from 'pixelarticons/react/ToolCase.js'
import { expect } from 'storybook/test'
import { Link } from '../link/link.tsx'
import { Notice } from './notice.tsx'

const meta = {
  title: 'Components/Notice',
  component: Notice,
  args: { label: '维护提示', children: null },
  decorators: [
    (Story) => (
      <div className="w-180">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Notice>

export default meta
type Story = StoryObj<typeof meta>

export const Maintenance: Story = {
  render: (args) => (
    <Notice {...args} icon={<ToolCase />} action={<Link href="#settings">维护设置</Link>}>
      维护模式已开启：除了管理员，别人打开站点只能看到维护页。外置登录和皮肤加载照常。
    </Notice>
  ),
  // 是地标，不是实时区域：每个页面都有，不该被读屏软件主动读出
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('complementary', { name: '维护提示' })).toBeVisible()
    await expect(canvas.queryByRole('status')).toBeNull()
  },
}

export const WithoutAction: Story = {
  render: (args) => (
    <Notice {...args} label="站点公告">
      本周六 22:00 到 23:00 迁移服务器，期间站点和外置登录都暂停使用，背包和权限数据不受影响。
    </Notice>
  ),
}

/** 窄屏：链接换到第二行，和文字左对齐 */
export const Narrow: Story = {
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
  render: (args) => (
    <Notice {...args} icon={<ToolCase />} action={<Link href="#settings">维护设置</Link>}>
      维护模式已开启：除了管理员，别人打开站点只能看到维护页。
    </Notice>
  ),
}
