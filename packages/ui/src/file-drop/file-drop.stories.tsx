import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, waitFor } from 'storybook/test'
import { FileDrop } from './file-drop.tsx'

const onFile = fn()

const meta = {
  title: 'Components/FileDrop',
  component: FileDrop,
  args: {
    onFile,
    accept: 'image/png',
    title: '把 PNG 文件拖到这里',
    description: '皮肤宽度是 64 的倍数，披风是 64×32 或 22×17 的整数倍。最大 1024 KB',
    buttonLabel: '选择文件',
  },
  decorators: [
    (Story) => (
      <div className="w-120">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof FileDrop>

export default meta
type Story = StoryObj<typeof meta>

/** 点按钮选文件，或者把文件拖进来 */
export const Default: Story = {
  play: async ({ canvas, canvasElement }) => {
    const input = canvasElement.querySelector<HTMLInputElement>('input[type="file"]')!
    await userEvent.upload(input, new File(['png'], 'miku.png', { type: 'image/png' }))
    await expect(onFile).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'miku.png' }))
    await expect(canvas.getByRole('button', { name: '选择文件' })).toBeVisible()
  },
}

/** 拖着文件经过时，边框和底色变成强调色 */
export const DragOver: Story = {
  play: async ({ canvas, canvasElement }) => {
    const zone = canvasElement.querySelector<HTMLElement>('.border-dashed')!
    const transfer = new DataTransfer()
    transfer.items.add(new File(['png'], 'cape.png', { type: 'image/png' }))
    zone.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }))
    await waitFor(() => expect(zone).toHaveAttribute('data-over'))
    await expect(canvas.getByText('把 PNG 文件拖到这里')).toBeVisible()
  },
}

export const Invalid: Story = {
  args: { error: '这个文件不是有效的 PNG 图片，换一个文件试试。' },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('button', { name: '选择文件' })).toHaveAccessibleDescription(
      '这个文件不是有效的 PNG 图片，换一个文件试试。',
    )
  },
}

export const Disabled: Story = {
  args: { disabled: true, description: '请先验证邮箱，再上传材质' },
}
