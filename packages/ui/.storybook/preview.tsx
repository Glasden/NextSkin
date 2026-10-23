import type { Preview } from '@storybook/react-vite'
import './preview.css'

// 亮色、暗色两种模式都要覆盖（DESIGN.md §10）。工具栏切换 data-mode，token 随之切换。
const preview: Preview = {
  globalTypes: {
    mode: {
      description: '亮暗模式',
      toolbar: { icon: 'mirror', items: ['light', 'dark'], dynamicTitle: true },
    },
  },
  initialGlobals: { mode: 'light' },
  decorators: [
    (Story, { globals }) => {
      document.documentElement.dataset.mode = globals.mode === 'dark' ? 'dark' : 'light'
      // 截图回归按这个元素截取（visual/stories.spec.ts），四周留出硬边阴影和焦点框的位置。
      // 字体要在这里再设一次：Storybook 给外层的 .sb-wrapper 设了自己的字体
      return (
        <div data-screenshot className="inline-block p-2 font-sans text-text">
          <Story />
        </div>
      )
    },
  ],
}

export default preview
