import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent } from 'storybook/test'
import { Link } from '../link/link.tsx'
import { fixture, type FixtureName } from '../skin-figure/fixtures.ts'
import { SkinFigure } from '../skin-figure/skin-figure.tsx'
import { Podium, type PodiumPlace } from './podium.tsx'

const meta = {
  title: 'Components/Podium',
  component: Podium,
  args: { title: '本周收藏最多', places: [], vacantLabel: '这个名次还空着' },
} satisfies Meta<typeof Podium>

export default meta
type Story = StoryObj<typeof meta>

function place(rank: number, name: string, texture: FixtureName, gain: number): PodiumPlace {
  return {
    name,
    figure: <SkinFigure {...fixture(texture)} scale={5} alt={`${name}的皮肤`} />,
    score: `♥ +${gain}`,
    label: `第 ${rank} 名：${name}，最近 7 天 ${gain} 人收藏`,
    render: <a href={`#${texture}`} />,
  }
}

const top = [
  place(1, '初音未来 · 樱花季', 'hatsune_miku', 214),
  place(2, '红金装甲（高清）', 'ironman_hd', 167),
  place(3, '旧版 64×32 的经典款，名字特别长', 'sethbling', 98),
]

/** 台阶从左到右是第二、第一、第三名；名字太长时名牌截断 */
export const Full: Story = {
  render: () => (
    <div className="w-130">
      <Podium title="本周收藏最多" period="10.12 – 10.18" places={top} vacantLabel="这个名次还空着" />
    </div>
  ),
  play: async ({ canvas }) => {
    // 读屏软件按名次读，链接的名字里有名次、材质名和数字
    await expect(canvas.getAllByRole('link').map((link) => link.getAttribute('aria-label'))).toEqual(
      top.map((item) => item.label),
    )
    // 第一名的台阶在中间
    const items = canvas.getAllByRole('listitem')
    const x = items.map((item) => item.getBoundingClientRect().x)
    await expect(x[1]! < x[0]! && x[0]! < x[2]!).toBe(true)
    await userEvent.tab()
    await expect(canvas.getByRole('link', { name: top[0]!.label })).toHaveFocus()
    ;(document.activeElement as HTMLElement).blur()
  },
}

/** 不满三个时，空着的台阶上放人形剪影，不拿别的皮肤补位（ADR-0032） */
export const Partial: Story = {
  render: () => (
    <div className="w-130">
      <Podium title="本周收藏最多" period="10.12 – 10.18" places={top.slice(0, 1)} vacantLabel="这个名次还空着" />
    </div>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getAllByRole('link')).toHaveLength(1)
    await expect(canvas.getAllByRole('img', { name: '这个名次还空着' })).toHaveLength(2)
  },
}

/** 一个都没有时，标题下面说明原因并给一个去处（DESIGN.md §7） */
export const Empty: Story = {
  render: () => (
    <div className="w-130">
      <Podium
        title="本周收藏最多"
        period="10.12 – 10.18"
        places={[]}
        vacantLabel="这个名次还空着"
        empty={
          <>
            最近 7 天还没有人收藏皮肤，<Link href="#skinlib">去皮肤库看看</Link>
          </>
        }
      />
    </div>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getAllByRole('img', { name: '这个名次还空着' })).toHaveLength(3)
    await expect(canvas.getByRole('link', { name: '去皮肤库看看' })).toBeVisible()
  },
}

/** 窄屏：每个台阶 96px 宽，皮肤仍按 ×5 显示 */
export const Narrow: Story = {
  render: () => (
    <div className="w-80">
      <Podium title="本周收藏最多" period="10.12 – 10.18" places={top} vacantLabel="这个名次还空着" />
    </div>
  ),
}
