import type { Meta, StoryObj } from '@storybook/react-vite'
import { SkinFigure } from '../skin-figure/skin-figure.tsx'
import { fixture } from '../skin-figure/fixtures.ts'
import { Stage } from './stage.tsx'

const meta = {
  title: 'Components/Stage',
  component: Stage,
  args: { children: null },
} satisfies Meta<typeof Stage>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <div className="h-44 w-60">
      <Stage>
        <SkinFigure {...fixture('haka')} scale={4} alt="Haka 的皮肤" />
      </Stage>
    </div>
  ),
}

/** 登录页插图：大展台加网格，皮肤按 ×8 显示 */
export const Grid: Story = {
  render: () => (
    <div className="h-88 w-80">
      <Stage grid>
        <SkinFigure {...fixture('ironman_hd')} scale={8} alt="红金装甲的皮肤" loading="eager" />
      </Stage>
    </div>
  ),
}
