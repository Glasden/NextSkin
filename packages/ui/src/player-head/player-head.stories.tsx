import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect } from 'storybook/test'
import { headFixture } from '../skin-figure/fixtures.ts'
import { PlayerHead } from './player-head.tsx'

const miku = headFixture('hatsune_miku')
const ironman = headFixture('ironman_hd')

const meta = {
  title: 'Components/PlayerHead',
  component: PlayerHead,
  args: { ...miku, size: 32, alt: 'Miku 的头像' },
} satisfies Meta<typeof PlayerHead>

export default meta
type Story = StoryObj<typeof meta>

/** 四种尺寸：脸是 8×8 个标准像素，分别放大 2、3、4、6 倍；帽子层比脸大一圈，伸到方框外面 */
export const Sizes: Story = {
  render: () => (
    <div className="flex items-end gap-4">
      {([16, 24, 32, 48] as const).map((size) => (
        <PlayerHead key={size} {...miku} size={size} alt={`Miku 的头像，${size}px`} />
      ))}
    </div>
  ),
  play: async ({ canvas }) => {
    // 按 48px 的脸排版，出图是 9×9 格的 54px，四周各伸出 3px
    const head = canvas.getByRole('img', { name: 'Miku 的头像，48px' })
    await expect(head).toHaveAttribute('width', '54')
    await expect(head).toHaveStyle({ left: '-3px', top: '-3px' })
    await expect(head.parentElement).toHaveStyle({ width: '48px', height: '48px' })
  },
}

/** 出图密度和皮肤的分辨率无关：32px 的头像 1x 屏 p = 4，2x 屏 p = 8，高清皮肤（s = 8）也一样 */
export const Skins: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <PlayerHead {...headFixture('haka')} size={48} alt="Haka 的头像" />
      <PlayerHead {...headFixture('sethbling')} size={48} alt="SethBling 的头像（旧版 64×32）" />
      <PlayerHead {...ironman} size={32} alt="红金装甲的头像（高清）" />
      <PlayerHead {...headFixture('default-skin')} size={48} alt="默认皮肤的头像" />
    </div>
  ),
  play: async ({ canvas }) => {
    // 和 fixture 给出的地址比，不按文件名匹配：静态构建会把小图内联成 data URI
    const hd = canvas.getByRole('img', { name: '红金装甲的头像（高清）' })
    await expect(hd).toHaveAttribute('src', ironman.src(4))
    await expect(hd).toHaveAttribute('srcset', `${ironman.src(4)} 1x, ${ironman.src(8)} 2x`)
    const haka = headFixture('haka')
    await expect(canvas.getByRole('img', { name: 'Haka 的头像' })).toHaveAttribute(
      'srcset',
      `${haka.src(6)} 1x, ${haka.src(12)} 2x`,
    )
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
