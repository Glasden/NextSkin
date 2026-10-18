import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect } from 'storybook/test'
import { Pagination, pageWindow } from './pagination.tsx'

const meta = {
  title: 'Components/Pagination',
  component: Pagination,
  args: {
    page: 6,
    pageCount: 20,
    href: (page: number) => `#page-${page}`,
    label: '皮肤库分页',
    previousLabel: '上一页',
    nextLabel: '下一页',
    pageLabel: (page: number) => `第 ${page} 页`,
  },
} satisfies Meta<typeof Pagination>

export default meta
type Story = StoryObj<typeof meta>

/** 第一页、最后一页、当前页和它两边各一页；当前页不是链接 */
export const Middle: Story = {
  play: async ({ canvas }) => {
    const nav = canvas.getByRole('navigation', { name: '皮肤库分页' })
    await expect(nav).toBeVisible()
    await expect(canvas.getByRole('link', { name: '第 7 页' })).toHaveAttribute('href', '#page-7')
    await expect(canvas.queryByRole('link', { name: '第 6 页' })).toBeNull()
    await expect(canvas.getByText('第 6 页', { selector: '[aria-current="page"] > *' })).toBeInTheDocument()
    await expect(canvas.getByRole('link', { name: '上一页' })).toHaveAttribute('href', '#page-5')
    await expect(pageWindow(6, 20)).toEqual([1, null, 5, 6, 7, null, 20])
    // 只隔一页时直接显示那一页
    await expect(pageWindow(4, 20)).toEqual([1, 2, 3, 4, 5, null, 20])
  },
}

/** 第一页没有“上一页”的链接，但位置留着 */
export const First: Story = {
  args: { page: 1, pageCount: 3 },
  play: async ({ canvas }) => {
    await expect(canvas.queryByRole('link', { name: '上一页' })).toBeNull()
    await expect(canvas.getByRole('link', { name: '下一页' })).toHaveAttribute('href', '#page-2')
  },
}

export const Last: Story = {
  args: { page: 20, pageCount: 20 },
}

/** 窄屏只显示“当前页 / 总页数”和两个箭头 */
export const Narrow: Story = {
  // 断点按视口宽度（md），截图用 720px 宽的视口
  tags: ['screenshot-viewport'],
}
