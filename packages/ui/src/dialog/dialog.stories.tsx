import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, screen, userEvent, waitFor } from 'storybook/test'
import { Button } from '../button/button.tsx'
import { Field } from '../field/field.tsx'
import { Form } from '../form/form.tsx'
import { Input } from '../input/input.tsx'
import { Dialog, DialogClose } from './dialog.tsx'

const meta = {
  title: 'Components/Dialog',
  component: Dialog,
  // 对话框渲染在 body 下、按视口定位，截图截整个视口
  tags: ['screenshot-viewport'],
  args: { title: '', actions: null },
} satisfies Meta<typeof Dialog>

export default meta
type Story = StoryObj<typeof meta>

const blur = () => (document.activeElement as HTMLElement | null)?.blur()
const onSubmit = fn()

/** 表单放在对话框里：提交按钮在底部，用 form 属性关联表单；打开时焦点落在输入框上 */
export const WithForm: Story = {
  name: 'With form',
  render: () => (
    <Dialog
      trigger={<Button variant="primary">添加角色</Button>}
      title="添加角色"
      description="添加一个角色要 100 积分，你现在有 1000 积分。"
      actions={
        <>
          <DialogClose>取消</DialogClose>
          <Button type="submit" form="add-player" variant="primary">
            添加角色
          </Button>
        </>
      }
    >
      <Form id="add-player" onFormSubmit={onSubmit}>
        <Field label="角色名" name="name" description="3 到 16 个字符，只能包含英文字母、数字和下划线。">
          <Input required autoComplete="off" />
        </Field>
      </Form>
    </Dialog>
  ),
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole('button', { name: '添加角色' }))
    const dialog = await screen.findByRole('dialog', { name: '添加角色' })
    await expect(dialog).toHaveAccessibleDescription('添加一个角色要 100 积分，你现在有 1000 积分。')
    const input = screen.getByRole('textbox', { name: '角色名' })
    await waitFor(() => expect(input).toHaveFocus())
    await userEvent.type(input, 'Steve{Enter}')
    await expect(onSubmit).toHaveBeenCalledWith({ name: 'Steve' }, expect.anything())
    blur()
  },
}

/** 不可逆操作的确认：写明后果，确认按钮写具体动作。点外面不关闭，Esc 和“取消”可以关闭 */
export const Confirm: Story = {
  render: () => (
    <Dialog
      alert
      trigger={<Button variant="danger">删除</Button>}
      title="删除角色 Steve？"
      description="删除后退还 100 积分，无法恢复。"
      actions={
        <>
          <DialogClose>取消</DialogClose>
          <Button variant="danger">删除角色</Button>
        </>
      }
    />
  ),
  play: async ({ canvas }) => {
    const trigger = canvas.getByRole('button', { name: '删除' })
    await userEvent.click(trigger)
    const dialog = await screen.findByRole('alertdialog', { name: '删除角色 Steve？' })
    // 焦点先落在“取消”上，误按回车不会删除
    await waitFor(() => expect(screen.getByRole('button', { name: '取消' })).toHaveFocus())
    // 进场动画是阶跃的，前 40ms 不透明度为 0
    await waitFor(() => expect(dialog).toBeVisible())
    await userEvent.click(document.body)
    await expect(dialog).not.toHaveAttribute('data-ending-style')
    await expect(dialog).toBeVisible()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    // 关闭后焦点回到触发它的按钮
    await expect(trigger).toHaveFocus()
    await userEvent.click(trigger)
    await screen.findByRole('alertdialog')
    blur()
  },
}
