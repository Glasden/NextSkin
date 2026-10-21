import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect } from 'storybook/test'
import { headFixture } from '../skin-figure/fixtures.ts'
import { PlayerHead } from './player-head.tsx'

const miku = headFixture('hatsune_miku')

const meta = {
  title: 'Components/PlayerHead',
  component: PlayerHead,
  args: { ...miku, size: 32, alt: 'Miku 的头像' },
} satisfies Meta<typeof PlayerHead>

export default meta
type Story = StoryObj<typeof meta>

/** 四种尺寸：脸是 8×8 个标准像素，分别放大 2、3、4、6 倍 */
export const Sizes: Story = {
  render: () => (
    <div className="flex items-end gap-4">
      {([16, 24, 32, 48] as const).map((size) => (
        <PlayerHead key={size} {...miku} size={size} alt={`Miku 的头像，${size}px`} />
      ))}
    </div>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('img', { name: 'Miku 的头像，48px' })).toHaveAttribute('width', '48')
  },
}

/** 高清皮肤（s = 8）：32px 显示 k = 4，2x 屏 k = 8；普通皮肤只有 k = 1，不给 srcset */
export const Skins: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <PlayerHead {...headFixture('haka')} size={48} alt="Haka 的头像" />
      <PlayerHead {...headFixture('sethbling')} size={48} alt="SethBling 的头像（旧版 64×32）" />
      <PlayerHead {...headFixture('ironman_hd')} size={32} alt="红金装甲的头像（高清）" />
      <PlayerHead {...headFixture('default-skin')} size={48} alt="默认皮肤的头像" />
    </div>
  ),
  play: async ({ canvas }) => {
    const hd = canvas.getByRole('img', { name: '红金装甲的头像（高清）' })
    await expect(hd.getAttribute('src')).toMatch(/ironman_hd-head-k4\.png/)
    await expect(hd.getAttribute('srcset')).toMatch(/ironman_hd-head-k8\.png[^,]* 2x$/)
    await expect(canvas.getByRole('img', { name: 'Haka 的头像' })).not.toHaveAttribute('srcset')
  },
}

/** 还没设头像的用户：标志的像素图形，和头像一样是 8×8 的网格，按整数倍放大 */
export const Placeholder: Story = {
  render: () => (
    <div className="flex items-end gap-4">
      {([16, 24, 32, 48] as const).map((size) => (
        <PlayerHead key={size} size={size} alt={`还没有头像，${size}px`} />
      ))}
    </div>
  ),
  play: async ({ canvas }) => {
    const heads = canvas.getAllByRole('img')
    await expect(heads).toHaveLength(4)
    await expect(heads[3]!.querySelector('svg')).toHaveAttribute('width', '48')
  },
}

/** 还没有皮肤的角色、已经注销的用户：同样大小的空白脸，画法与 FigurePlaceholder 一致 */
export const Blank: Story = {
  render: () => (
    <div className="flex items-end gap-4">
      {([16, 24, 32, 48] as const).map((size) => (
        <PlayerHead key={size} fallback="blank" size={size} alt={`还没有皮肤，${size}px`} />
      ))}
    </div>
  ),
  play: async ({ canvas }) => {
    const heads = canvas.getAllByRole('img')
    await expect(heads).toHaveLength(4)
    await expect(heads[0]!.querySelector('svg')).toBeNull()
  },
}

/** 旁边已经写了昵称时 alt 传空字符串，读屏软件不重复读名字 */
export const WithName: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <span className="flex items-center gap-2 text-sm text-text">
        <PlayerHead {...miku} size={24} alt="" />
        初音未来
      </span>
      <span className="flex items-center gap-2 text-sm text-text">
        <PlayerHead size={24} alt="" />
        还没有设头像的用户
      </span>
      <span className="flex items-center gap-2 text-sm text-text">
        <PlayerHead fallback="blank" size={24} alt="" />
        还没有皮肤的角色
      </span>
    </div>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.queryAllByRole('img')).toHaveLength(0)
  },
}
