import { expect, test } from 'vitest'
import { visibleWidgets, widgetContent } from './plugin-widgets'

const markdown = { kind: 'markdown', source: '/widget' } as const
const stats = { kind: 'stats', source: '/stats' } as const

const plugins: Parameters<typeof visibleWidgets>[0] = [
  {
    id: 'zeta',
    ui: {
      pages: { links: { area: 'user' } },
      widgets: [
        {
          name: 'share',
          slot: 'user.dashboard',
          title: 'w',
          link: { page: 'links', label: 'l' },
          view: markdown,
        },
      ],
    },
  },
  {
    id: 'alpha',
    ui: {
      pages: {
        codes: { area: 'admin', permission: 'manage' },
        mine: { area: 'user', permission: 'manage' },
      },
      widgets: [
        { name: 'b', slot: 'user.dashboard', title: 'w', view: markdown },
        { name: 'a', slot: 'user.dashboard', title: 'w', permission: 'manage', view: stats },
        {
          name: 'mine',
          slot: 'user.dashboard',
          title: 'w',
          link: { page: 'mine', label: 'l' },
          view: markdown,
        },
        {
          name: 'codes',
          slot: 'admin.dashboard',
          title: 'w',
          link: { page: 'codes', label: 'l' },
          view: stats,
        },
      ],
    },
  },
]

const names = (list: ReturnType<typeof visibleWidgets>) =>
  list.map(({ pluginId, widget }) => `${pluginId}/${widget.name}`)

test('挂件按插件 id、再按声明的顺序；只取这个插槽的', () => {
  expect(names(visibleWidgets(plugins, 'user.dashboard', 'admin'))).toEqual([
    'alpha/b',
    'alpha/a',
    'alpha/mine',
    'zeta/share',
  ])
  expect(names(visibleWidgets(plugins, 'admin.dashboard', 'superadmin'))).toEqual(['alpha/codes'])
})

test('普通用户看不到要求插件权限的挂件和后台概览上的挂件，封禁的用户什么都看不到', () => {
  expect(names(visibleWidgets(plugins, 'user.dashboard', 'user'))).toEqual(['alpha/b', 'alpha/mine', 'zeta/share'])
  expect(visibleWidgets(plugins, 'admin.dashboard', 'user')).toEqual([])
  expect(visibleWidgets(plugins, 'user.dashboard', 'banned')).toEqual([])
})

test('标题旁边的链接：页面要存在、区域一致，看的人没有权限看那个页面时不链', () => {
  const href = (role: 'user' | 'admin', name: string) =>
    visibleWidgets(plugins, 'user.dashboard', role).find(({ widget }) => widget.name === name)?.href
  expect(href('user', 'share')).toBe('/user/plugins/zeta/links')
  expect(href('user', 'mine')).toBeNull()
  expect(href('admin', 'mine')).toBe('/user/plugins/alpha/mine')
  expect(visibleWidgets(plugins, 'admin.dashboard', 'admin')[0]?.href).toBe('/admin/plugins/alpha/codes')
})

test('数据源的响应：204 不显示；其他状态码、没响应、形状不对算没能加载；统计最多 4 项', () => {
  expect(widgetContent(markdown, { status: 204, data: null, text: '' })).toBe('hidden')
  expect(widgetContent(markdown, null)).toBeNull()
  expect(widgetContent(markdown, { status: 404, data: null, text: 'nope' })).toBeNull()
  expect(widgetContent(markdown, { status: 200, data: null, text: '# hi' })).toEqual({ kind: 'markdown', text: '# hi' })
  expect(widgetContent(stats, { status: 200, data: { rows: [] }, text: '' })).toBeNull()
  const items = [1, 2, 3, 4, 5].map((value) => ({ label: `n${value}`, value }))
  expect(widgetContent(stats, { status: 200, data: { items: [{ label: 1, value: 1 }, ...items] }, text: '' })).toEqual({
    kind: 'stats',
    items: items.slice(0, 4),
  })
})
