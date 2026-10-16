import type { Preview } from '@storybook/react-vite'
import './preview.css'

// 亮色、暗色两种模式都要覆盖（DESIGN.md §10）。工具栏切换 data-theme，token 随之切换。
const preview: Preview = {
  globalTypes: {
    theme: {
      description: '配色模式',
      toolbar: { icon: 'mirror', items: ['light', 'dark'], dynamicTitle: true },
    },
  },
  initialGlobals: { theme: 'light' },
  decorators: [
    (Story, { globals }) => {
      document.documentElement.dataset.theme = globals.theme === 'dark' ? 'dark' : 'light'
      return <Story />
    },
  ],
}

export default preview
