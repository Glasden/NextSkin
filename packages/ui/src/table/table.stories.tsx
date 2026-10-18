import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent } from 'storybook/test'
import { Badge } from '../badge/badge.tsx'
import { Button } from '../button/button.tsx'
import { PlayerHead } from '../player-head/player-head.tsx'
import { headFixture, type FixtureName } from '../skin-figure/fixtures.ts'
import { Table, type TableColumn, type TableRow } from './table.tsx'

type Column = 'uid' | 'user' | 'email' | 'role' | 'score' | 'registered' | 'actions'

const columns: readonly TableColumn<Column>[] = [
  { key: 'uid', header: 'UID', align: 'end', shrink: true },
  { key: 'user', header: '用户' },
  { key: 'email', header: '邮箱' },
  { key: 'role', header: '角色', shrink: true },
  { key: 'score', header: '积分', align: 'end', shrink: true },
  { key: 'registered', header: '注册时间', shrink: true },
  { key: 'actions', header: '操作', shrink: true },
]

const user = (
  uid: number,
  nickname: string,
  email: string,
  role: { label: string; tone?: 'neutral' | 'warning' | 'danger' },
  score: number,
  registered: string,
  head: Exclude<FixtureName, 'mojang_cape' | 'legacy_cape'> | null,
  action: string | null,
): TableRow<Column> => ({
  key: uid,
  cells: {
    uid,
    user: (
      <span className="flex items-center gap-2">
        {head ? <PlayerHead {...headFixture(head)} size={24} alt="" /> : <PlayerHead size={24} alt="" />}
        <span className="min-w-0 truncate">{nickname}</span>
      </span>
    ),
    email,
    role: <Badge tone={role.tone}>{role.label}</Badge>,
    score: score.toLocaleString('zh-CN'),
    registered,
    actions: action ? <Button size="sm">{action}</Button> : null,
  },
})

const rows = [
  user(
    1024,
    'Miku',
    'miku@example.test',
    { label: '管理员', tone: 'warning' },
    1200,
    '2026-10-01 20:14',
    'hatsune_miku',
    null,
  ),
  user(1023, 'Haka', 'haka@example.test', { label: '用户' }, 87_310, '2026-09-28 08:02', 'haka', '封禁'),
  user(
    1007,
    '一个很长很长、在表格里放不下的昵称',
    'a.very.long.address.for.testing@example.test',
    { label: '已封禁', tone: 'danger' },
    0,
    '2026-03-11 13:45',
    null,
    '解封',
  ),
  user(17, 'SethBling', 'seth@example.test', { label: '用户' }, 360, '2025-12-24 23:59', 'sethbling', '封禁'),
]

const meta = {
  title: 'Components/Table',
  component: Table<Column>,
  args: { label: '用户列表', columns, rows, empty: '没有符合条件的用户' },
} satisfies Meta<typeof Table<Column>>

export default meta
type Story = StoryObj<typeof meta>

/** 后台的用户列表：数字列靠右、用等宽数字；UID、时间、操作只占内容的宽度，其余的列平分剩下的宽度 */
export const Users: Story = {
  play: async ({ canvas }) => {
    const table = canvas.getByRole('table', { name: '用户列表' })
    await expect(table).toBeVisible()
    await expect(canvas.getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      'UID',
      '用户',
      '邮箱',
      '角色',
      '积分',
      '注册时间',
      '操作',
    ])
    // 表头一行加四行数据
    await expect(canvas.getAllByRole('row')).toHaveLength(5)
    await expect(canvas.getByRole('cell', { name: '87,310' })).toHaveClass('text-right')
  },
}

/** 没有行时，表格里显示一句话，表头照样留着 */
export const Empty: Story = {
  args: { rows: [] },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('cell', { name: '没有符合条件的用户' })).toBeVisible()
    await expect(canvas.getAllByRole('columnheader')).toHaveLength(7)
  },
}

/** 窄屏放不下时，在表格自己的容器里横向滚动；容器能用 Tab 聚焦，方向键滚动 */
export const Narrow: Story = {
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvas }) => {
    const region = canvas.getByRole('region', { name: '用户列表' })
    await expect(region.scrollWidth).toBeGreaterThan(region.clientWidth)
    await userEvent.tab()
    await expect(region).toHaveFocus()
    region.blur()
  },
}
