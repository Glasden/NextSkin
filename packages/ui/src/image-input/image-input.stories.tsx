import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, waitFor } from 'storybook/test'
import { uploadedLogo } from '../logo/fixtures.ts'
import { LogoMark } from '../logo/logo.tsx'
import { ImageInput } from './image-input.tsx'

const onFile = fn()
const onReset = fn()

const meta = {
  title: 'Components/ImageInput',
  component: ImageInput,
  args: {
    label: '站点标志',
    status: '默认图形',
    src: null,
    // 标志的图形是 8×8 格，每格 size / 8 像素
    fallback: (size: number) => <LogoMark cell={size / 8} />,
    sizes: [64, 32, 24],
    previewLabel: '站点标志的预览',
    onFile,
    accept: 'image/png',
    uploadLabel: '上传图片',
    resetLabel: '恢复默认',
    description: 'PNG，正方形，边长 16–512 像素，不超过 1 MiB。边长不到 64 像素的当作像素画，按整数倍放大。',
  },
  decorators: [
    (Story) => (
      <div className="w-120">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ImageInput>

export default meta
type Story = StoryObj<typeof meta>

/** 没有上传时画内置的图形；没有 onReset 时不显示“恢复默认” */
export const Default: Story = {
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('group', { name: '站点标志' })).toBeVisible()
    await expect(canvas.getByRole('img', { name: '站点标志的预览' })).toBeVisible()
    await expect(canvas.queryByRole('button', { name: '恢复默认' })).toBeNull()
    const input = canvasElement.querySelector<HTMLInputElement>('input[type="file"]')!
    await userEvent.upload(input, new File(['png'], 'logo.png', { type: 'image/png' }))
    await expect(onFile).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'logo.png' }))
    await expect(canvas.getByRole('button', { name: '上传图片' })).toHaveAccessibleDescription(
      'PNG，正方形，边长 16–512 像素，不超过 1 MiB。边长不到 64 像素的当作像素画，按整数倍放大。',
    )
  },
}

/** 上传以后按每个尺寸画在棋盘格上，透明的四角看得出来 */
export const Uploaded: Story = {
  args: { src: uploadedLogo, status: '已上传', onReset },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvasElement.querySelectorAll('img')).toHaveLength(3)
    await userEvent.click(canvas.getByRole('button', { name: '恢复默认' }))
    await expect(onReset).toHaveBeenCalled()
    ;(document.activeElement as HTMLElement | null)?.blur()
  },
}

/** 图标用浏览器标签页、书签和主屏幕上的尺寸 */
export const Favicon: Story = {
  args: {
    label: '站点图标',
    status: '跟着站点标志',
    src: uploadedLogo,
    sizes: [64, 32, 16],
    previewLabel: '站点图标的预览',
  },
}

/** 拖着文件经过预览时，边框和底色变成强调色 */
export const DragOver: Story = {
  play: async ({ canvas }) => {
    const zone = canvas.getByRole('img', { name: '站点标志的预览' })
    const transfer = new DataTransfer()
    transfer.items.add(new File(['png'], 'logo.png', { type: 'image/png' }))
    zone.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }))
    await waitFor(() => expect(zone).toHaveAttribute('data-over'))
    zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
    await expect(onFile).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'logo.png' }))
    await waitFor(() => expect(zone).not.toHaveAttribute('data-over'))
    // 再拖进来一次，截图停在经过时的样子
    zone.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }))
  },
}

export const Uploading: Story = {
  args: { src: uploadedLogo, status: '已上传', onReset, uploading: true },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('button', { name: '恢复默认' })).toBeDisabled()
  },
}

export const Invalid: Story = {
  args: { error: '图片尺寸 640×480 不符合要求：要正方形，边长 16 到 512 像素。' },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('button', { name: '上传图片' })).toHaveAccessibleDescription(
      'PNG，正方形，边长 16–512 像素，不超过 1 MiB。边长不到 64 像素的当作像素画，按整数倍放大。 图片尺寸 640×480 不符合要求：要正方形，边长 16 到 512 像素。',
    )
  },
}
