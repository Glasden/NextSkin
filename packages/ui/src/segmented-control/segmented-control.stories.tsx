import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent } from 'storybook/test'
import { Field } from '../field/field.tsx'
import { SegmentedControl } from './segmented-control.tsx'

const types = [
  { value: 'skin', label: '全部皮肤' },
  { value: 'steve', label: 'Steve' },
  { value: 'alex', label: 'Alex' },
  { value: 'cape', label: '披风' },
] as const

const onValueChange = fn()

const meta = {
  title: 'Components/SegmentedControl',
  component: SegmentedControl,
  args: { options: types, defaultValue: 'skin', 'aria-label': '材质类型', onValueChange },
} satisfies Meta<typeof SegmentedControl>

export default meta
type Story = StoryObj<typeof meta>

/** 皮肤库的类型筛选。点击或方向键切换，选中块整段挪过去 */
export const Default: Story = {
  play: async ({ canvas }) => {
    const group = canvas.getByRole('radiogroup', { name: '材质类型' })
    await expect(canvas.getByRole('radio', { name: '全部皮肤' })).toBeChecked()
    await userEvent.click(canvas.getByRole('radio', { name: 'Alex' }))
    await expect(onValueChange).toHaveBeenLastCalledWith('alex')
    await userEvent.keyboard('{ArrowRight}')
    await expect(canvas.getByRole('radio', { name: '披风' })).toBeChecked()
    await expect(onValueChange).toHaveBeenLastCalledWith('cape')
    // 结束前移开焦点：模拟点击留下的焦点框，真实的鼠标点击不会有
    ;(document.activeElement as HTMLElement | null)?.blur()
    await expect(group).toBeVisible()
  },
}

/** 和同一行的 Input、Button 取相同的尺寸 */
export const Sizes: Story = {
  render: () => (
    <div className="flex flex-col items-start gap-4">
      <SegmentedControl
        size="sm"
        aria-label="排序（小）"
        defaultValue="latest"
        options={[
          { value: 'latest', label: '最新' },
          { value: 'popular', label: '最热' },
        ]}
      />
      <SegmentedControl
        aria-label="排序"
        defaultValue="popular"
        options={[
          { value: 'latest', label: '最新' },
          { value: 'popular', label: '最热' },
        ]}
      />
    </div>
  ),
}

/** 上传页的模型选择：放在 Field 里占满宽度，标签给整组，每个选项仍用自己的文字；提交的是 name 对应的值 */
export const InForm: Story = {
  render: () => (
    <form className="w-80" aria-label="上传">
      <Field label="模型" name="type" nativeLabel={false}>
        <SegmentedControl
          fullWidth
          defaultValue="alex"
          options={[
            { value: 'steve', label: 'Steve' },
            { value: 'alex', label: 'Alex' },
            { value: 'cape', label: '披风' },
          ]}
        />
      </Field>
    </form>
  ),
  play: async ({ canvas }) => {
    const form = canvas.getByRole<HTMLFormElement>('form', { name: '上传' })
    await expect(new FormData(form).get('type')).toBe('alex')
    await expect(canvas.getByRole('radiogroup', { name: '模型' })).toBeVisible()
    await expect(canvas.getByRole('radio', { name: 'Alex' })).toBeChecked()
  },
}

export const Disabled: Story = {
  args: { disabled: true, defaultValue: 'steve' },
}
