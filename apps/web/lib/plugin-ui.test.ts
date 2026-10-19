import { afterEach, expect, test, vi } from 'vitest'
import { callPlugin, fillRoute } from '../app/_plugins/plugin-request'
import { pluginSettingText } from './plugin-settings'
import { pluginSourceQuery, pluginUrl } from './plugin-url'

afterEach(() => vi.unstubAllGlobals())

test.each(['/../../api/admin', '/%2e%2e/%2e%2e/api', '/../other/items', '/..\\..\\api'])(
  '规范化后离开插件路径就拒绝且不发请求：%s',
  async (path) => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect(() => pluginUrl('example', path, 'https://skin.example.test')).toThrow('invalid plugin path')
    await expect(callPlugin('example', 'POST', path)).rejects.toThrow('invalid plugin path')
    expect(fetch).not.toHaveBeenCalled()
  },
)

test('路径前缀带分隔边界；保留数据源查询并合并分页参数', () => {
  const source = pluginSourceQuery(
    '/items?scope=active&page=9&q=old',
    new URLSearchParams({ page: '2', pageSize: '50', q: 'a & b' }),
  )
  const url = pluginUrl('example', source, 'https://skin.example.test')
  expect(url.pathname).toBe('/plugins/example/items')
  expect([...url.searchParams]).toEqual([
    ['scope', 'active'],
    ['page', '2'],
    ['q', 'a & b'],
    ['pageSize', '50'],
  ])
  expect(() => pluginUrl('example', '/../example-other/items', url.origin)).toThrow()
})

test.each([null, undefined, true, {}, [], NaN, Infinity, '.', '..'])(
  '行字段不是字符串或有限数字，或为点段时拒绝：%j',
  (id) => {
    expect(() => fillRoute('/items/:id', { id })).toThrow('invalid plugin route parameter')
  },
)

test('行字段编码路径与查询，接受零和 Unicode', () => {
  expect(fillRoute('/items/:id?name=:name', { id: 0, name: 'a/你好?' })).toBe('/items/0?name=a%2F%E4%BD%A0%E5%A5%BD%3F')
})

test('对象内枚举选项使用 fields.<属性>.options.<值> 文案，缺失时回退到值', () => {
  const messages: Record<string, string> = { 'settings.theme.fields.color.options.blue': '蓝色' }
  const text = pluginSettingText((key) => messages[key] ?? key, {
    key: 'theme',
    unreadable: false,
    control: { kind: 'object', properties: [{ name: 'color', control: { kind: 'select', options: ['blue', 'red'] } }] },
  })
  expect(text.fields?.color?.options).toEqual({ blue: '蓝色', red: 'red' })
})

test('动作请求不跟随重定向：插件的路由回 3xx 时按失败处理，不会带着会话请求别的地址', async () => {
  // 浏览器的 fetch 在 redirect: 'error' 时遇到重定向就抛 TypeError
  const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.reject(new TypeError('Failed to fetch')))
  vi.stubGlobal('fetch', fetch)
  await expect(callPlugin('example', 'POST', '/go', { a: 1 })).resolves.toEqual({ ok: false, message: null })
  expect(fetch).toHaveBeenCalledWith(
    '/plugins/example/go',
    expect.objectContaining({ method: 'POST', redirect: 'error' }),
  )
})
