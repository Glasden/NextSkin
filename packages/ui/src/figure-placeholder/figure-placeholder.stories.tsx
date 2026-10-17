import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect } from 'storybook/test'
import { fixture } from '../skin-figure/fixtures.ts'
import { SkinFigure } from '../skin-figure/skin-figure.tsx'
import { Stage } from '../stage/stage.tsx'
import { FigurePlaceholder } from './figure-placeholder.tsx'

const meta = {
  title: 'Components/FigurePlaceholder',
  component: FigurePlaceholder,
  args: { scale: 4, label: 'Steve 还没有皮肤' },
} satisfies Meta<typeof FigurePlaceholder>

export default meta
type Story = StoryObj<typeof meta>

/** 各个倍数下与 SkinFigure 等高，站在同一条地面上 */
export const NextToSkinFigure: Story = {
  name: 'Next to SkinFigure',
  render: () => (
    <div className="h-80 w-140">
      <Stage grid>
        <div className="flex items-end gap-8">
          {([3, 4, 5] as const).map((scale) => (
            <FigurePlaceholder key={scale} scale={scale} label={`还没有皮肤，×${scale}`} />
          ))}
          <SkinFigure {...fixture('hatsune_miku')} scale={5} alt="初音未来的皮肤" />
        </div>
      </Stage>
    </div>
  ),
  play: async ({ canvas }) => {
    const placeholder = canvas.getByRole('img', { name: '还没有皮肤，×5' })
    const figure = canvas.getByRole('img', { name: '初音未来的皮肤' })
    await expect(placeholder.getBoundingClientRect().height).toBe(figure.getBoundingClientRect().height)
  },
}
