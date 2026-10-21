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

/** 登录页插图：大展台加网格，皮肤只显示正面、按 ×8 显示。站点还没有材质时用随核心发布的默认皮肤 */
export const Grid: Story = {
  render: () => (
    <div className="h-88 w-80">
      <Stage grid>
        <SkinFigure {...fixture('default-skin')} scale={8} view="front" alt="cxchency 的皮肤" loading="eager" />
      </Stage>
    </div>
  ),
}
