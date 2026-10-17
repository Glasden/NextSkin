import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, screen, userEvent, waitFor } from 'storybook/test'
import { Button } from '../button/button.tsx'
import { ToastProvider, useToast, type ToastOptions } from './toast.tsx'

function Trigger({ label, options }: { label: string; options: ToastOptions }) {
  const toast = useToast()
  return <Button onClick={() => toast.show(options)}>{label}</Button>
}

const meta = {
  title: 'Components/Toast',
  component: ToastProvider,
  // 通知渲染在 body 下、按视口定位，截图截整个视口
  tags: ['screenshot-viewport'],
  args: { label: '通知', closeLabel: '关闭', children: null },
  decorators: [
    (Story, { args }) => (
      <ToastProvider label={args.label} closeLabel={args.closeLabel}>
        <Story />
      </ToastProvider>
    ),
  ],
} satisfies Meta<typeof ToastProvider>

export default meta
type Story = StoryObj<typeof meta>

const blur = () => (document.activeElement as HTMLElement | null)?.blur()

/** 按标题找通知的外框。warning 和 danger 的外框对读屏软件隐藏，按角色查不出名字 */
const toastByTitle = (title: string) =>
  screen
    .getAllByText(title)
    .map((element) => element.closest<HTMLElement>('[role="dialog"], [role="alertdialog"]'))
    .find((toast) => toast !== null)!

export const Tones: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <Trigger label="信息" options={{ title: '已复制外置登录地址', timeout: 0 }} />
      <Trigger label="成功" options={{ tone: 'success', title: '设置已保存', timeout: 0 }} />
      <Trigger
        label="警告"
        options={{
          tone: 'warning',
          title: '已保存，有一个角色没有更新',
          description: '角色“Notch”已被封禁，没有换上新皮肤。',
          timeout: 0,
        }}
      />
      <Trigger
        label="错误"
        options={{
          tone: 'danger',
          title: '保存失败',
          description: '网络连接中断了，你填写的内容还在。稍后再试一次。',
          timeout: 0,
        }}
      />
    </div>
  ),
  play: async ({ canvas }) => {
    for (const name of ['信息', '成功', '警告', '错误']) {
      await userEvent.click(canvas.getByRole('button', { name }))
    }
    // 警告和错误要立即读出：Base UI 把它们另放一份到 role="alert" 的隐藏区域里，通知本身对读屏软件隐藏
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2))
    // 最多显示 3 条，最早的那条藏起来
    const info = toastByTitle('已复制外置登录地址')
    await expect(info).toHaveAttribute('data-limited')
    await expect(info).not.toBeVisible()
    // 新的在最下面
    const top = (title: string) => toastByTitle(title).getBoundingClientRect().top
    await expect(top('保存失败')).toBeGreaterThan(top('设置已保存'))
    blur()
  },
}

const onUndo = fn()

export const WithAction: Story = {
  name: 'With action',
  render: () => (
    <Trigger
      label="移出衣柜"
      options={{
        title: '已移出衣柜',
        description: '“初音未来”不会再出现在你的衣柜里。',
        action: { label: '撤销', onClick: onUndo },
        timeout: 0,
      }}
    />
  ),
  // 点了操作按钮，通知随之关闭
  play: async ({ canvas }) => {
    onUndo.mockClear()
    await userEvent.click(canvas.getByRole('button', { name: '移出衣柜' }))
    await userEvent.click(await screen.findByRole('button', { name: '撤销' }))
    await expect(onUndo).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await userEvent.click(canvas.getByRole('button', { name: '移出衣柜' }))
    // 刚出现时处在淡入的起点，透明度为 0
    const toast = await screen.findByRole('dialog', { name: '已移出衣柜' })
    await waitFor(() => expect(toast).toBeVisible())
    blur()
  },
}

export const Dismiss: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <Trigger label="不自动关闭" options={{ tone: 'success', title: '设置已保存', timeout: 0 }} />
      <Trigger label="很快关闭" options={{ title: '已复制', timeout: 300 }} />
    </div>
  ),
  play: async ({ canvas }) => {
    // 关闭按钮
    // 鼠标不在通知上、焦点也不在里面时，Base UI 对读屏软件隐藏关闭按钮，免得它混进播报
    await userEvent.click(canvas.getByRole('button', { name: '不自动关闭' }))
    await userEvent.hover(await screen.findByRole('dialog', { name: '设置已保存' }))
    await userEvent.click(screen.getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    // 键盘：F6 跳到通知区域，Tab 进入通知，Esc 关闭
    await userEvent.click(canvas.getByRole('button', { name: '不自动关闭' }))
    const toast = await screen.findByRole('dialog', { name: '设置已保存' })
    await userEvent.keyboard('{F6}')
    await expect(screen.getByRole('region', { name: '通知' })).toHaveFocus()
    await userEvent.tab()
    await expect(toast).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    // 向右滑动关闭
    await userEvent.click(canvas.getByRole('button', { name: '不自动关闭' }))
    const swiped = await screen.findByRole('dialog', { name: '设置已保存' })
    const { left, top, height } = swiped.getBoundingClientRect()
    const at = (x: number) => ({ clientX: left + x, clientY: top + height / 2 })
    await userEvent.pointer([
      { keys: '[MouseLeft>]', target: swiped, coords: at(40) },
      { target: swiped, coords: at(120) },
      { target: swiped, coords: at(200) },
      { keys: '[/MouseLeft]', target: swiped, coords: at(200) },
    ])
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    // 到时间自动关闭
    await userEvent.click(canvas.getByRole('button', { name: '很快关闭' }))
    await expect(await screen.findByRole('dialog', { name: '已复制' })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 2000 })
    blur()
  },
}
