import type { Meta, StoryObj } from '@storybook/react-vite'
import { useEffect, useState } from 'react'
import { expect, fn, screen, userEvent, waitFor } from 'storybook/test'
import { Field } from '../field/field.tsx'
import { PlayerHead } from '../player-head/player-head.tsx'
import { headFixture, type FixtureName } from '../skin-figure/fixtures.ts'
import { MultiCombobox, type MultiComboboxProps } from './multi-combobox.tsx'

interface User {
  uid: number
  nickname: string
  email: string
  head: Exclude<FixtureName, 'mojang_cape' | 'legacy_cape'> | null
}

const users: readonly User[] = [
  { uid: 3, nickname: 'Miku', email: 'miku@example.test', head: 'hatsune_miku' },
  { uid: 8, nickname: 'Haka', email: 'haka@example.test', head: 'haka' },
  { uid: 15, nickname: 'SethBling', email: 'seth@example.test', head: 'sethbling' },
  { uid: 21, nickname: 'IronMan_HD_With_A_Long_Name', email: 'ironman@example.test', head: 'ironman_hd' },
  { uid: 34, nickname: 'NoAvatarYet', email: 'new@example.test', head: null },
]
const [miku, haka, seth] = users as [User, User, User]

const head = (user: User) =>
  user.head ? <PlayerHead {...headFixture(user.head)} size={24} alt="" /> : <PlayerHead size={24} alt="" />

// 后台发通知的样子：下拉里是头像、昵称、邮箱和 uid，小卡片只有头像和昵称
const common = {
  itemKey: (user: User) => String(user.uid),
  itemLabel: (user: User) => user.nickname,
  renderItem: (user: User) => (
    <>
      {head(user)}
      <span className="min-w-0 truncate">{user.nickname}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-text-muted">{user.email}</span>
      <span className="shrink-0 font-mono text-sm text-text-muted">{user.uid}</span>
    </>
  ),
  renderChip: (user: User) => (
    <>
      {head(user)}
      <span className="min-w-0 truncate">{user.nickname}</span>
    </>
  ),
  emptyLabel: '没有找到这个用户',
  hintLabel: '输入 uid、昵称或邮箱',
  loadingLabel: '正在搜索',
  removeLabel: (label: string) => `移除 ${label}`,
  placeholder: '输入 uid、昵称或邮箱',
} satisfies Partial<MultiComboboxProps<User>>

/** 受控的已选项，onValueChange 同时记进 spy */
function Controlled({
  initial = [],
  onValueChange,
  ...props
}: Omit<MultiComboboxProps<User>, 'value'> & { initial?: readonly User[] }) {
  const [value, setValue] = useState<readonly User[]>(initial)
  return (
    <MultiCombobox
      {...props}
      value={value}
      onValueChange={(next) => {
        setValue(next)
        onValueChange(next)
      }}
    />
  )
}

const meta = {
  title: 'Components/MultiCombobox',
  component: Controlled,
  args: { ...common, items: users, onValueChange: fn() },
  decorators: [
    (Story) => (
      <div className="w-120">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Controlled>

export default meta
type Story = StoryObj<typeof meta>

const blur = () => (document.activeElement as HTMLElement | null)?.blur()

/**
 * 放在 Field 里，在本地按昵称过滤。点一项选中，输入框清空；选中的排成下方的小卡片，点 × 移除。
 * 输入框右边是“已选 / 上限”
 */
export const Default: Story = {
  args: { initial: [miku], max: 50 },
  render: (args) => (
    <Field label="收件人" description="可以发给被封禁的用户。">
      <Controlled {...args} />
    </Field>
  ),
  play: async ({ args, canvas }) => {
    const input = canvas.getByRole('combobox', { name: '收件人' })
    await expect(input).toHaveAccessibleDescription('可以发给被封禁的用户。')
    await expect(canvas.getByText('1 / 50')).toBeVisible()
    await userEvent.click(input)
    await userEvent.type(input, 'ha')
    await userEvent.click(await screen.findByRole('option', { name: /Haka/ }))
    await expect(args.onValueChange).toHaveBeenLastCalledWith([miku, haka])
    await waitFor(() => expect(input).toHaveValue(''))
    await expect(canvas.getByRole('button', { name: '移除 Haka' })).toBeVisible()
    await expect(canvas.getByText('2 / 50')).toBeVisible()
    // 已选的在下拉里打勾，再点一次取消
    await userEvent.type(input, 'i')
    const selected = await screen.findByRole('option', { name: /Miku/ })
    await expect(selected).toHaveAttribute('aria-selected', 'true')
    await userEvent.click(selected)
    await expect(args.onValueChange).toHaveBeenLastCalledWith([haka])
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    // 点小卡片不打开下拉
    await userEvent.click(canvas.getByText('Haka'))
    await expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    await userEvent.click(canvas.getByRole('button', { name: '移除 Haka' }))
    await expect(args.onValueChange).toHaveBeenLastCalledWith([])
    await expect(canvas.queryByRole('button', { name: /^移除/ })).toBeNull()
    await expect(canvas.getByText('0 / 50')).toBeVisible()
    // 截图里留两张小卡片，一张名字很长
    await userEvent.type(input, 'iron')
    await userEvent.click(await screen.findByRole('option', { name: /IronMan/ }))
    await userEvent.type(input, 'no')
    await userEvent.click(await screen.findByRole('option', { name: /NoAvatarYet/ }))
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    blur()
  },
}

/** 打开的下拉：已选的打勾，长名字和邮箱在行内截断。截图里列表保持打开 */
export const Open: Story = {
  // 列表渲染在 body 下、按视口定位，截图截整个视口
  tags: ['screenshot-viewport'],
  args: { initial: [miku, haka], 'aria-label': '收件人' },
  play: async ({ canvas }) => {
    const input = canvas.getByRole('combobox', { name: '收件人' })
    await userEvent.click(input)
    await userEvent.type(input, 'i')
    await expect(await screen.findAllByRole('option')).toHaveLength(3)
    await expect(screen.getByRole('option', { name: /Miku/ })).toHaveAttribute('aria-selected', 'true')
    await expect(screen.getByRole('option', { name: /SethBling/ })).toHaveAttribute('aria-selected', 'false')
  },
}

/** 模拟的服务端搜索，300ms 后返回 */
function Remote(props: Omit<MultiComboboxProps<User>, 'value' | 'items'>) {
  const [value, setValue] = useState<readonly User[]>([])
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<{ query: string; items: readonly User[] }>({ query: '', items: [] })
  useEffect(() => {
    const q = query.trim().toLowerCase()
    if (!q) return
    const timer = setTimeout(
      () =>
        setResult({
          query,
          items: users.filter(
            (user) => String(user.uid) === q || user.nickname.toLowerCase().includes(q) || user.email.includes(q),
          ),
        }),
      300,
    )
    return () => clearTimeout(timer)
  }, [query])
  return (
    <MultiCombobox
      {...props}
      value={value}
      onValueChange={(next) => {
        setValue(next)
        props.onValueChange(next)
      }}
      items={query.trim() && result.query === query ? result.items : []}
      inputValue={query}
      onInputValueChange={setQuery}
      loading={query.trim() !== '' && result.query !== query}
    />
  )
}

const submit = fn()

/**
 * 远程搜索：传了 inputValue，组件不再过滤，items 是服务端的结果。输入框为空时提示能搜什么，
 * 等结果时顶上显示“正在搜索”，没有匹配时说明。结果到之前按回车什么也不做（不提交表单），
 * 到了以后第一项高亮，回车选中
 */
export const Search: Story = {
  args: { 'aria-label': '收件人' },
  render: (args) => (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <Remote {...args} />
    </form>
  ),
  beforeEach: () => submit.mockClear(),
  play: async ({ args, canvas }) => {
    const input = canvas.getByRole('combobox', { name: '收件人' })
    await userEvent.click(input)
    await expect(await screen.findByText('输入 uid、昵称或邮箱')).toBeVisible()
    await userEvent.type(input, 'seth')
    // "正在搜索"只挂 300ms：找到和断言放在同一次检查里，CI 慢的时候中间的空档会错过它
    await waitFor(() => expect(screen.getByText('正在搜索')).toBeVisible())
    await userEvent.click(await screen.findByRole('option', { name: /SethBling/ }))
    await expect(args.onValueChange).toHaveBeenLastCalledWith([seth])
    await userEvent.type(input, 'nobody')
    await expect(await screen.findByText('没有找到这个用户')).toBeVisible()
    await expect(screen.queryByText('正在搜索')).toBeNull()
    await userEvent.clear(input)
    await userEvent.type(input, '8{Enter}')
    await expect(submit).not.toHaveBeenCalled()
    await expect(screen.getByRole('listbox')).toBeVisible()
    await waitFor(() => expect(screen.getByRole('option', { name: /Haka/ })).toHaveAttribute('data-highlighted'))
    await userEvent.keyboard('{Enter}')
    await expect(args.onValueChange).toHaveBeenLastCalledWith([seth, haka])
    await expect(submit).not.toHaveBeenCalled()
    await userEvent.keyboard('{Escape}')
    blur()
  },
}

/**
 * 键盘：输入框为空时退格删掉最后一张；左方向键移到小卡片上，Delete 删掉当前这张。
 * 下拉关着时按 Esc 什么也不清
 */
export const Keyboard: Story = {
  args: { initial: [miku, haka, seth], 'aria-label': '收件人' },
  play: async ({ args, canvas }) => {
    const input = canvas.getByRole('combobox', { name: '收件人' })
    await userEvent.click(input)
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    await userEvent.keyboard('{Escape}')
    await expect(args.onValueChange).not.toHaveBeenCalled()
    await expect(canvas.getAllByRole('button', { name: /^移除/ })).toHaveLength(3)
    await userEvent.keyboard('{Backspace}')
    await expect(args.onValueChange).toHaveBeenLastCalledWith([miku, haka])
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}')
    await expect(canvas.getByRole('button', { name: '移除 Miku' }).parentElement).toHaveFocus()
    await userEvent.keyboard('{Delete}')
    await expect(args.onValueChange).toHaveBeenLastCalledWith([haka])
    blur()
  },
}

/** 选满了：没选的候选项不能再选，“已选 / 上限”提醒为什么 */
export const Full: Story = {
  tags: ['screenshot-viewport'],
  args: { initial: [miku, haka], max: 2, 'aria-label': '收件人' },
  play: async ({ args, canvas }) => {
    const input = canvas.getByRole('combobox', { name: '收件人' })
    await expect(canvas.getByText('2 / 2')).toBeVisible()
    await userEvent.click(input)
    await userEvent.type(input, 'i')
    const other = await screen.findByRole('option', { name: /SethBling/ })
    await expect(other).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(other)
    await expect(args.onValueChange).not.toHaveBeenCalled()
  },
}

/** Field 的禁用和错误信息同样作用在搜索框和小卡片上 */
export const States: Story = {
  args: { initial: [miku, haka] },
  render: (args) => (
    <div className="flex flex-col gap-4">
      <Field label="禁用" disabled>
        <Controlled {...args} />
      </Field>
      <Field label="收件人" error="uid 99 的用户不存在，删掉它再发送">
        <Controlled {...args} />
      </Field>
    </div>
  ),
  play: async ({ args, canvas }) => {
    const disabled = canvas.getByRole('combobox', { name: '禁用' })
    await expect(disabled).toBeDisabled()
    const [remove] = canvas.getAllByRole('button', { name: '移除 Miku' })
    await userEvent.click(remove!)
    await expect(args.onValueChange).not.toHaveBeenCalled()
    const invalid = canvas.getByRole('combobox', { name: '收件人' })
    await expect(invalid).toHaveAttribute('aria-invalid', 'true')
    await expect(invalid).toHaveAccessibleDescription('uid 99 的用户不存在，删掉它再发送')
  },
}
