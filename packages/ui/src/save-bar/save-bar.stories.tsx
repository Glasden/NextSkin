import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState, type ReactNode } from 'react'
import { expect, userEvent, waitFor } from 'storybook/test'
import { Button } from '../button/button.tsx'
import { Field } from '../field/field.tsx'
import { Input } from '../input/input.tsx'
import { SaveBar } from './save-bar.tsx'

const meta = {
  title: 'Components/SaveBar',
  component: SaveBar,
  args: { dirty: false, children: null },
  decorators: [
    (Story) => (
      <div className="w-160">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SaveBar>

export default meta
type Story = StoryObj<typeof meta>

/** 后台设置的面板：每项之间一条分隔线，保存栏是最后一个子元素 */
function Panel({ rows, children }: { rows: { label: string; value: string }[]; children: ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-surface">
      <div className="divide-y divide-border">
        {rows.map((row) => (
          <div key={row.label} className="px-4 py-5 sm:px-6">
            <Field label={row.label}>
              <Input defaultValue={row.value} />
            </Field>
          </div>
        ))}
      </div>
      {children}
    </div>
  )
}

const site = [
  { label: '站点名称', value: '像素工坊' },
  { label: '站点地址', value: 'https://skin.example.com' },
]

export const Clean: Story = {
  render: (args) => (
    <Panel rows={site}>
      <SaveBar {...args}>
        <Button type="submit">保存</Button>
      </SaveBar>
    </Panel>
  ),
}

export const Dirty: Story = {
  args: { dirty: true, status: '1 项改动还没保存' },
  render: Clean.render,
}

export const Failed: Story = {
  args: { dirty: true, error: '有的设置没有通过检查，按提示改好后再保存。' },
  render: Clean.render,
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('alert')).toHaveTextContent('有的设置没有通过检查')
  },
}

const servers = Array.from({ length: 20 }, (_, index) => `mc${index + 1}.example.com`)

/** 比视口长的表单：改了一项，保存栏吸在视口底部 */
function LongForm() {
  const [values, setValues] = useState(servers)
  const changed = values.filter((value, index) => value !== servers[index]).length
  return (
    <div className="rounded-md border border-border bg-surface">
      <div className="divide-y divide-border">
        {values.map((value, index) => (
          <div key={index} className="px-4 py-5 sm:px-6">
            <Field label={`服务器 ${index + 1} 的地址`}>
              <Input value={value} onValueChange={(next) => setValues((current) => current.with(index, next))} />
            </Field>
          </div>
        ))}
      </div>
      <SaveBar dirty={changed > 0} status={changed > 0 && `${changed} 项改动还没保存`}>
        <Button type="submit">保存</Button>
      </SaveBar>
    </div>
  )
}

export const Pinned: Story = {
  tags: ['screenshot-viewport'],
  render: () => <LongForm />,
  play: async ({ canvas }) => {
    const root = document.documentElement
    const fields = canvas.getAllByRole('textbox')
    const bar = canvas.getByRole('button', { name: '保存' }).parentElement!.parentElement!
    const obscured = (element: Element) => element.getBoundingClientRect().bottom > bar.getBoundingClientRect().top

    // 没有改动时留在表单末尾，在视口外面
    await expect(bar.getBoundingClientRect().top).toBeGreaterThan(window.innerHeight)

    // 改了一项就吸在视口底部，并给页面留出同样高的滚动内边距
    await userEvent.type(fields[0]!, '0')
    await expect(canvas.getByText('1 项改动还没保存')).toBeVisible()
    await expect(Math.round(bar.getBoundingClientRect().bottom)).toBe(window.innerHeight)
    await waitFor(() => expect(bar).toHaveAttribute('data-floating'))
    await expect(root.style.scrollPaddingBottom).toBe(`${bar.offsetHeight + 16}px`)

    // 用 Tab 往下走，每一项都滚到栏的上方，不被盖住
    for (let step = 0; step < 8; step++) {
      await userEvent.tab()
      await expect(obscured(document.activeElement!)).toBe(false)
    }

    // 滚到表单末尾，回到原处
    window.scrollTo(0, root.scrollHeight)
    await waitFor(() => expect(bar).not.toHaveAttribute('data-floating'))

    // 改回去就没有改动了：不再吸住，滚动内边距也撤掉
    await userEvent.type(fields[0]!, '{Backspace}')
    await expect(bar).not.toHaveAttribute('data-dirty')
    await expect(root.style.scrollPaddingBottom).toBe('')

    // 栏刚吸住时盖住了正在改的那一项（贴着视口底边），把它挪到栏的上方
    const edge = fields[12]!
    edge.scrollIntoView({ block: 'end' })
    await userEvent.type(edge, '0')
    await expect(obscured(edge)).toBe(false)

    // 点了被栏盖住一半的项（露出来的那一半），同样挪到栏的上方。
    // 真实的鼠标点击聚焦时浏览器不滚动；模拟的点击调用 focus()，浏览器会自己滚，所以这里直接聚焦
    const half = fields[14]!
    window.scrollBy(0, half.getBoundingClientRect().bottom - bar.getBoundingClientRect().top - 20)
    await expect(obscured(half)).toBe(true)
    half.focus({ preventScroll: true })
    await expect(obscured(half)).toBe(false)

    // 截图：回到开头，栏浮在视口底部
    window.scrollTo(0, 0)
    half.blur()
    await waitFor(() => expect(bar).toHaveAttribute('data-floating'))
  },
}
