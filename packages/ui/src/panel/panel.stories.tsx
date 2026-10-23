import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect } from 'storybook/test'
import { Badge } from '../badge/badge.tsx'
import { Button } from '../button/button.tsx'
import { Panel } from './panel.tsx'

const meta = {
  title: 'Components/Panel',
  component: Panel,
} satisfies Meta<typeof Panel>

export default meta
type Story = StoryObj<typeof meta>

/** 页面上的一块内容：标题、说明和操作竖着排，24px 内边距 */
export const Default: Story = {
  render: () => (
    <div className="max-w-md">
      <Panel gap={4}>
        <h2 className="font-pixel text-pixel-2 text-text">积分</h2>
        <p className="text-sm text-text-muted">每个角色占用 100 积分，每天签到可以领 10–20 积分。</p>
        <div>
          <Button variant="primary">签到</Button>
        </div>
      </Panel>
    </div>
  ),
}

/** 列表：不要内边距，子元素之间画分隔线 */
export const List: Story = {
  render: () => (
    <div className="max-w-md">
      <Panel as="ul" padding="none" divided aria-label="已启用的主题">
        {['钻石青', '钴蓝', '高对比'].map((name, index) => (
          <li key={name} className="flex items-center justify-between gap-3 px-4 py-3 text-sm text-text">
            {name}
            {index === 0 && <Badge>默认</Badge>}
          </li>
        ))}
      </Panel>
    </div>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('list', { name: '已启用的主题' }).children).toHaveLength(3)
  },
}

/** 面板里套的框：inset 透出外面的底色，bg、sunken 换底色，都不带静止阴影 */
export const Tones: Story = {
  render: () => (
    <div className="max-w-md">
      <Panel gap={3}>
        <Panel tone="inset" padding="md">
          inset：只有边框
        </Panel>
        <Panel tone="bg" padding="md">
          bg：页面底色
        </Panel>
        <Panel tone="sunken" padding="sm">
          sunken：凹陷的底色，12px 内边距
        </Panel>
        <Panel as="ul" tone="inset" padding="none" divided>
          <li className="px-4 py-2 text-sm text-text">对话框里的列表</li>
          <li className="px-4 py-2 text-sm text-text">不带底色</li>
        </Panel>
      </Panel>
    </div>
  ),
}

/** 和别的面板并排时 grow 占满剩下的宽度，两块一样高 */
export const Grow: Story = {
  render: () => (
    <div className="flex max-w-xl gap-4">
      <Panel grow gap={3} padding="responsive">
        <p className="font-pixel text-pixel-3 text-text tabular-nums">1,280</p>
        <p className="text-sm text-text-muted">窄屏 16px、sm 以上 24px 的内边距</p>
      </Panel>
      <Panel padding="md">
        <p className="text-sm text-text">另一块</p>
      </Panel>
    </div>
  ),
}
