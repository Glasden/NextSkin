import { DIAMOND } from '@nextskin/theme'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, userEvent } from 'storybook/test'
import { Badge } from '../badge/badge.tsx'
import { Button } from '../button/button.tsx'
import { Switch } from '../switch/switch.tsx'
import { cobalt, ember, highContrast, previewCss } from './fixtures.ts'
import { ThemeCard } from './theme-card.tsx'

const meta = {
  title: 'Components/ThemeCard',
  component: ThemeCard,
  args: { theme: DIAMOND, name: '钻石青' },
  decorators: [
    (Story) => (
      <>
        <style>{previewCss}</style>
        <Story />
      </>
    ),
  ],
} satisfies Meta<typeof ThemeCard>

export default meta
type Story = StoryObj<typeof meta>

/**
 * 后台的主题页：每套可用的主题一张卡片，亮暗两份小样、名字和来源，底部是“启用”开关和“设为默认”。
 * 站点默认的那套加粗边框、名字前的方框打勾，开关不能关
 */
export const Admin: Story = {
  render: function Render() {
    const [enabled, setEnabled] = useState(false)
    return (
      <div className="grid w-180 grid-cols-2 gap-4">
        <ThemeCard
          theme={DIAMOND}
          name="钻石青"
          description="内置"
          badge={<Badge>默认</Badge>}
          selected="站点默认"
          actions={
            <Switch checked disabled>
              启用
            </Switch>
          }
        />
        <ThemeCard
          theme={cobalt}
          name="钴蓝"
          description="更多配色"
          actions={
            <>
              <Switch checked={enabled} onCheckedChange={setEnabled}>
                启用
              </Switch>
              <Button size="sm" variant="secondary">
                设为默认
              </Button>
            </>
          }
        />
      </div>
    )
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('heading', { name: '钻石青' })).toBeVisible()
    await expect(canvas.getByText('站点默认')).toBeInTheDocument()
    const toggle = canvas.getByRole('switch', { name: '启用', checked: false })
    await userEvent.click(toggle)
    await expect(toggle).toBeChecked()
    // 小样不读出来：卡片的名字已经说明了是哪套
    await expect(canvasElement.querySelectorAll('[data-theme][aria-hidden="true"]')).toHaveLength(4)
    ;(document.activeElement as HTMLElement | null)?.blur()
  },
}

/**
 * 小样只认自己的 data-theme 和 data-mode：亮色的那份在暗色页面里照样是亮的。
 * 结构也跟着小样的主题：高对比的小样里卡片是直角、粗边框、静止带阴影，外面的卡片照旧（ADR-0058）
 */
export const Previews: Story = {
  render: () => (
    <div className="grid w-180 grid-cols-2 gap-4">
      <ThemeCard theme={cobalt} name="钴蓝" description="更多配色" />
      <ThemeCard theme={ember} name="余烬" description="示例插件：连底色一起改" />
      <ThemeCard theme={highContrast} name="高对比" description="更多配色" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const [light, dark] = canvasElement.querySelectorAll(`[data-theme="${cobalt}"]`)
    await expect(getComputedStyle(light!).getPropertyValue('--color-accent')).toBe('#2a52e5')
    await expect(getComputedStyle(dark!).getPropertyValue('--color-accent')).toBe('#86a2ff')
    const [contrastLight, contrastDark] = canvasElement.querySelectorAll(`[data-theme="${highContrast}"]`)
    await expect(getComputedStyle(contrastLight!).getPropertyValue('--color-accent-fill')).toBe('#d4ff1e')
    await expect(getComputedStyle(contrastLight!).getPropertyValue('--radius-sm')).toBe('0')
    // 色块没写时跟着强调色
    await expect(getComputedStyle(contrastDark!).getPropertyValue('--color-accent-fill')).toBe('#d4ff1e')
    await expect(getComputedStyle(light!).getPropertyValue('--radius-sm')).toBe('2px')
  },
}
