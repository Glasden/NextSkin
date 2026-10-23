import { resolveTheme, themeCss } from '@nextskin/theme'
import type { Preview } from '@storybook/react-vite'
import './preview.css'

// 主题的结构全开（ADR-0058）：钻石青的颜色加上直角、粗边框、静止带阴影的卡片，只看结构，不看配色
const STRUCTURE_THEME = 'fixture/structure'
const structureCss = themeCss(STRUCTURE_THEME, resolveTheme(), { radius: 'square', borders: 'thick', cards: 'raised' })

// 亮色、暗色两种模式都要覆盖（DESIGN.md §10）。工具栏切换 data-mode，token 随之切换；
// "结构"切换 data-theme，截图回归另拍一张亮色加结构全开的
const preview: Preview = {
  globalTypes: {
    mode: {
      description: '亮暗模式',
      toolbar: { icon: 'mirror', items: ['light', 'dark'], dynamicTitle: true },
    },
    structure: {
      description: '主题的结构',
      toolbar: { icon: 'component', items: ['default', 'all'], dynamicTitle: true },
    },
  },
  initialGlobals: { mode: 'light', structure: 'default' },
  decorators: [
    (Story, { globals }) => {
      const root = document.documentElement
      root.dataset.mode = globals.mode === 'dark' ? 'dark' : 'light'
      const structured = globals.structure === 'all'
      if (structured) root.dataset.theme = STRUCTURE_THEME
      else delete root.dataset.theme
      // 截图回归按这个元素截取（visual/stories.spec.ts），四周留出硬边阴影和焦点框的位置。
      // 字体要在这里再设一次：Storybook 给外层的 .sb-wrapper 设了自己的字体
      return (
        <div data-screenshot className="inline-block p-2 font-sans text-text">
          {structured && <style>{structureCss}</style>}
          <Story />
        </div>
      )
    },
  ],
}

export default preview
