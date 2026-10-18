import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor } from 'storybook/test'
import mikuUrl from '../../../skin/test/fixtures/hatsune_miku.png?url'
import capeUrl from '../../../skin/test/fixtures/mojang_cape.png?url'
import { SkinViewer, type SkinViewerLabels } from './skin-viewer.tsx'

const labels: SkinViewerLabels = {
  viewer: '初音未来的 3D 预览',
  animation: '动作',
  idle: '站立',
  walk: '行走',
  run: '奔跑',
  outerLayer: '显示外层',
  loading: '正在加载预览',
  failed: '预览加载失败，刷新页面试试',
}

const meta = {
  title: 'Components/SkinViewer',
  component: SkinViewer,
  // 截图要确定的画面：不转也不动
  args: { src: mikuUrl, type: 'alex', labels, motion: false },
  decorators: [
    (Story) => (
      <div className="w-120">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SkinViewer>

export default meta
type Story = StoryObj<typeof meta>

/** 材质详情页的视觉中心：带网格的展台，下面是动作和外层的开关 */
export const Skin: Story = {
  play: async ({ canvas }) => {
    await waitFor(() => expect(canvas.getByRole('img', { name: '初音未来的 3D 预览' })).toBeVisible(), {
      timeout: 10_000,
    })
    const outer = canvas.getByRole('switch', { name: '显示外层' })
    await expect(outer).toBeChecked()
    await userEvent.click(outer)
    await expect(outer).not.toBeChecked()
    // 不转也不动的时候，动作选不了
    await expect(canvas.getByRole('radio', { name: '行走' })).toHaveAttribute('aria-disabled', 'true')
    outer.blur()
  },
}

/** 披风单独显示，没有动作和外层的开关 */
export const Cape: Story = {
  args: { src: capeUrl, type: 'cape', labels: { ...labels, viewer: 'Mojang 披风的 3D 预览' } },
  play: async ({ canvas }) => {
    await waitFor(() => expect(canvas.getByRole('img', { name: 'Mojang 披风的 3D 预览' })).toBeVisible(), {
      timeout: 10_000,
    })
    await expect(canvas.queryByRole('switch')).toBeNull()
  },
}

/** 取不到材质时说明情况，不留一块空白 */
export const Failed: Story = {
  args: { src: '/no-such-texture.png' },
  play: async ({ canvas }) => {
    await waitFor(() => expect(canvas.getByRole('status')).toHaveTextContent('预览加载失败，刷新页面试试'))
  },
}
