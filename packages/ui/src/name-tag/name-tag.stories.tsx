import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect } from 'storybook/test'
import { FigurePlaceholder } from '../figure-placeholder/figure-placeholder.tsx'
import { fixture } from '../skin-figure/fixtures.ts'
import { SkinFigure } from '../skin-figure/skin-figure.tsx'
import { Stage } from '../stage/stage.tsx'
import { NameTag } from './name-tag.tsx'

const meta = {
  title: 'Components/NameTag',
  component: NameTag,
  args: { children: 'Hatsune_Miku' },
} satisfies Meta<typeof NameTag>

export default meta
type Story = StoryObj<typeof meta>

const lineup = [
  {
    name: 'Hatsune_Miku',
    figure: <SkinFigure {...fixture('hatsune_miku')} scale={4} view="front" alt="Hatsune_Miku 的皮肤" />,
  },
  { name: 'Steve', figure: <FigurePlaceholder scale={4} view="front" label="Steve 还没有皮肤" /> },
  {
    name: 'A_very_long_name_x',
    figure: <FigurePlaceholder scale={4} view="front" label="A_very_long_name_x 还没有皮肤" />,
  },
]

/** 名牌在人物头顶，和人物居中对齐；名字太长时截断 */
export const OverFigures: Story = {
  name: 'Over figures',
  render: () => (
    <div className="h-64 w-140">
      <Stage grid>
        <div className="flex items-end gap-8">
          {lineup.map(({ name, figure }) => (
            <div key={name} className="flex w-24 flex-col items-center gap-3">
              <NameTag>{name}</NameTag>
              {figure}
            </div>
          ))}
        </div>
      </Stage>
    </div>
  ),
  play: async ({ canvas }) => {
    const tag = canvas.getByText('A_very_long_name_x')
    await expect(tag.scrollWidth).toBeGreaterThan(tag.clientWidth)
  },
}
