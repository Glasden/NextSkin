import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor } from 'storybook/test'
import { Stage } from '../stage/stage.tsx'
import { focusRing } from '../styles.ts'
import { fixture } from './fixtures.ts'
import { SkinFigure } from './skin-figure.tsx'

const miku = fixture('hatsune_miku')

const meta = {
  title: 'Components/SkinFigure',
  component: SkinFigure,
  args: { ...miku, scale: 4, alt: '初音未来的皮肤' },
} satisfies Meta<typeof SkinFigure>

export default meta
type Story = StoryObj<typeof meta>

export const Scales: Story = {
  render: () => (
    <div className="h-80 w-200">
      <Stage>
        <div className="flex items-end gap-8">
          {([3, 4, 5, 8] as const).map((scale) => (
            <SkinFigure key={scale} {...miku} scale={scale} alt={`初音未来的皮肤，×${scale}`} />
          ))}
        </div>
      </Stage>
    </div>
  ),
  // 每个人物只有一张图；出图密度等于显示倍数乘设备像素比，浏览器不缩放。静态构建的文件名带 hash，所以不匹配到扩展名
  play: async ({ canvas }) => {
    await expect(canvas.getAllByRole('img')).toHaveLength(4)
    const large = canvas.getByRole<HTMLImageElement>('img', { name: '初音未来的皮肤，×8' })
    await expect(large.getAttribute('src')).toMatch(/hatsune_miku-both-p8[.-]/)
    await waitFor(() => expect(large.naturalWidth).toBe(Number(large.getAttribute('width'))))
  },
}

/** 正背面并排（材质卡片、角色卡）和只有正面（领奖台、插图、迷你卡片） */
export const Views: Story = {
  render: () => (
    <div className="h-48 w-120">
      <Stage>
        <div className="flex items-end gap-12">
          <SkinFigure {...miku} scale={4} alt="初音未来的皮肤，正背面" />
          <SkinFigure {...miku} scale={5} view="front" alt="初音未来的皮肤，正面" />
          <SkinFigure {...miku} scale={3} view="front" alt="初音未来的皮肤，正面 ×3" />
        </div>
      </Stage>
    </div>
  ),
}

export const Types: Story = {
  render: () => (
    <div className="h-48 w-240">
      <Stage>
        <div className="flex items-end gap-8">
          <SkinFigure {...fixture('haka')} scale={4} alt="Haka 的皮肤（经典）" />
          <SkinFigure {...fixture('hatsune_miku')} scale={4} alt="初音未来的皮肤（纤细）" />
          <SkinFigure {...fixture('sethbling')} scale={4} alt="SethBling 的皮肤（旧版 64×32）" />
          <SkinFigure {...fixture('ironman_hd')} scale={4} alt="红金装甲的皮肤（高清）" />
          <SkinFigure {...fixture('mojang_cape')} scale={4} alt="Mojang 披风" />
          <SkinFigure {...fixture('legacy_cape')} scale={4} alt="旧版披风" />
        </div>
      </Stage>
    </div>
  ),
  // 皮肤按出图密度取图，和材质的分辨率无关；披风还是按分辨率 k 取 2D 拼图，普通披风只有 k = 1，不给 srcset
  play: async ({ canvas }) => {
    const hd = canvas.getByRole('img', { name: '红金装甲的皮肤（高清）' })
    await expect(hd.getAttribute('src')).toMatch(/ironman_hd-both-p4[.-]/)
    await expect(hd.getAttribute('srcset')).toMatch(/ 2x$/)
    await expect(canvas.getByRole('img', { name: 'Mojang 披风' })).not.toHaveAttribute('srcset')
  },
}

export const Raise: Story = {
  // 材质卡片的做法：可以聚焦的祖先元素带 group/raise，鼠标移上去或键盘聚焦时才下载抬手拼图，下载好就抬手
  render: (args) => (
    <a href="#raise" className={`group/raise block rounded-md ${focusRing}`}>
      <div className="h-48 w-64">
        <Stage>
          <SkinFigure {...args} />
        </Stage>
      </div>
    </a>
  ),
  play: async ({ canvas, canvasElement }) => {
    await expect(canvasElement.querySelector('img[data-raise]')).toBeNull()
    await userEvent.tab()
    await expect(canvas.getByRole('link')).toHaveFocus()
    await waitFor(() => expect(canvasElement.querySelector('img[data-ready]')).not.toBeNull())
    const sprite = canvasElement.querySelector('img[data-ready]')!
    await expect(sprite.getAttribute('src')).toMatch(/hatsune_miku-both-raise-p4[.-]/)
    // 拼图向左挪四帧，停在最后一帧；静止图留着替代文字，只是透明
    const frame = sprite.parentElement!.getBoundingClientRect()
    await waitFor(() => expect(sprite.getBoundingClientRect().left - frame.left).toBe(-4 * frame.width))
    await expect(canvas.getByRole('img', { name: '初音未来的皮肤' })).toHaveClass('opacity-0')
  },
}
