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
    <div className="h-80 w-140">
      <Stage>
        <div className="flex items-end gap-8">
          {([3, 4, 5, 8] as const).map((scale) => (
            <SkinFigure key={scale} {...miku} scale={scale} alt={`初音未来的皮肤，×${scale}`} />
          ))}
        </div>
      </Stage>
    </div>
  ),
  // 背面那张图只是转身用的，对读屏软件隐藏：每个人物只有一张图
  play: async ({ canvas }) => {
    await expect(canvas.getAllByRole('img')).toHaveLength(4)
    await expect(canvas.getByRole('img', { name: '初音未来的皮肤，×8' })).toHaveAttribute('width', '256')
  },
}

export const Types: Story = {
  render: () => (
    <div className="h-48 w-140">
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
  // 高清皮肤（s = 8）在 ×4 下取 k = 4、2x 屏取 k = 8；普通皮肤只有 k = 1，不给 srcset
  play: async ({ canvas }) => {
    const hd = canvas.getByRole('img', { name: '红金装甲的皮肤（高清）' })
    await expect(hd.getAttribute('src')).toMatch(/ironman_hd-k4\.png/)
    await expect(hd.getAttribute('srcset')).toMatch(/ironman_hd-k8\.png[^,]* 2x$/)
    await expect(canvas.getByRole('img', { name: 'Haka 的皮肤（经典）' })).not.toHaveAttribute('srcset')
  },
}

export const Turn: Story = {
  // 材质卡片的做法：可以聚焦的祖先元素带 group/turn，鼠标移上去或键盘聚焦时转到背面
  render: (args) => (
    <a href="#turn" className={`group/turn block rounded-md ${focusRing}`}>
      <div className="h-48 w-40">
        <Stage>
          <SkinFigure {...args} />
        </Stage>
      </div>
    </a>
  ),
  play: async ({ canvas }) => {
    const front = canvas.getByRole('img', { name: '初音未来的皮肤' }).parentElement!
    const back = front.nextElementSibling!
    await expect(getComputedStyle(back).scale).toBe('0 1')
    await userEvent.tab()
    await expect(canvas.getByRole('link')).toHaveFocus()
    await waitFor(async () => {
      await expect(getComputedStyle(front).scale).toBe('0 1')
      await expect(getComputedStyle(back).scale).toBe('1')
    })
  },
}
