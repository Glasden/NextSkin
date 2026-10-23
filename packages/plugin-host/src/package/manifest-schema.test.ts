import { expect, test } from 'vitest'
import { definePlugin } from '@nextskin/plugin-sdk'
import invitation from '../../../../plugins/invitation-codes/src/official.ts'
import cdn from '../../../../plugins/cdn-refresh/src/official.ts'
import share from '../../../../plugins/share-registration-link/src/official.ts'
import colorThemes from '../../../../plugins/color-themes/src/official.ts'
import { buildManifest } from '../manifest.ts'
import { parsePluginManifest } from './manifest-schema.ts'
import { PluginPackageError } from './error.ts'

const pkg = { name: 'test', version: '1.0.0', nextskin: { id: 'test' } }
const base = { ...buildManifest(definePlugin({ capabilities: [] }), pkg), entry: { server: 'server.mjs' } }

/* eslint-disable nextskin/no-raw-color -- manifest 的主题是色值数据，这里校验合法输入和非法格式。 */
test('安装清单允许部分主题和大写色值，形状校验不拒绝失效配色', () => {
  const themes = [
    {
      name: 'partial',
      label: 'themes.partial',
      structure: { radius: 'square' },
      colors: { dark: { accent: '#86A2FF', 'accent-fill': '#86A2FF', 'accent-fill-fg': '#000000' } },
    },
    { name: 'empty', label: 'themes.empty', colors: {} },
    { name: 'invalid', label: 'themes.invalid', colors: { light: { accent: '#ffffff' } } },
  ]
  expect(parsePluginManifest({ ...base, ui: { themes } }).ui.themes).toEqual(themes)
})

test.each(
  [
    null,
    {},
    [null],
    [{ name: 'Bad', label: 'x', colors: {} }],
    [{ name: 'a'.repeat(33), label: 'x', colors: {} }],
    [{ name: 'a', colors: {} }],
    [{ name: 'a', label: 1, colors: {} }],
    [{ name: 'a', label: 'x' }],
    [{ name: 'a', label: 'x', colors: null }],
    [{ name: 'a', label: 'x', colors: { light: null } }],
    [{ name: 'a', label: 'x', colors: { dark: [] } }],
    [{ name: 'a', label: 'x', colors: { auto: {} } }],
    [{ name: 'a', label: 'x', colors: {}, extra: true }],
    ...['stage', 'checker-a', 'checker-b', 'acent'].map((name) => [
      { name: 'a', label: 'x', colors: { light: { [name]: '#ffffff' } } },
    ]),
    ...['#fff', '#ffffffff', '#ffffff\n', 'ffffff', 'rgb(0 0 0)', null].map((accent) => [
      { name: 'a', label: 'x', colors: { dark: { accent } } },
    ]),
    Array.from({ length: 2 }, () => ({ name: 'same', label: 'x', colors: {} })),
    Array.from({ length: 17 }, (_, i) => ({ name: `theme-${i}`, label: 'x', colors: {} })),
  ].map((themes) => ({ themes })),
)('manifest.json 拒绝错误的主题或多余键：%j', ({ themes }) => {
  expect(() => parsePluginManifest({ ...base, ui: { themes } })).toThrow(PluginPackageError)
  expect(() => parsePluginManifest({ ...base, ui: { themes } })).toThrow(/ui/)
})

test.each([null, [], { shadow: 'none' }, { radius: 'round' }, { borders: 'wide' }, { cards: 'floating' }])(
  '安装清单拒绝错误结构并指出 structure：%j',
  (structure) => {
    expect(() =>
      parsePluginManifest({ ...base, ui: { themes: [{ name: 'a', label: 'themes.a', colors: {}, structure }] } }),
    ).toThrow(/structure/)
  },
)

/* eslint-enable nextskin/no-raw-color */

test('官方插件的清单都能通过严格校验', () => {
  const manifests = [
    buildManifest(invitation.definition, invitation.package),
    buildManifest(cdn.definition, cdn.package),
    buildManifest(share.definition, share.package),
    buildManifest(colorThemes.definition, colorThemes.package),
  ]
  for (const manifest of manifests) {
    const complete = { ...manifest, entry: { server: 'server.mjs' }, integrity: { 'server.mjs': 'a'.repeat(64) } }
    expect(parsePluginManifest(complete)).toEqual(complete)
  }
})

test.each([
  ['id', 'a'.repeat(64)],
  ['version', `1.0.0-${'a'.repeat(58)}`],
] as const)('清单的 %s 最多 64 字符', (field, value) => {
  expect(value).toHaveLength(64)
  expect(parsePluginManifest({ ...base, [field]: value })[field]).toBe(value)
  expect(() => parsePluginManifest({ ...base, [field]: value + 'a' })).toThrow(
    expect.objectContaining({ code: 'invalid_manifest' }),
  )
  expect(() => parsePluginManifest({ ...base, [field]: value + 'a' })).toThrow(field)
})

test.each([
  ['manifestVersion', { manifestVersion: 2 }],
  ['id', { id: '../bad' }],
  ['version', { version: '01.0.0' }],
  ['api', { api: 'bad' }],
  ['requires', { requires: { Bad: '^1.0.0' } }],
  ['requires', { requires: { valid: 'bad' } }],
  ['conflicts', { conflicts: ['Bad'] }],
  ['capabilities', { capabilities: ['users.read', 'users.read'] }],
  ['capabilities', { capabilities: ['network'] }],
  ['network', { network: ['https://example.com/'] }],
  ['settingsSchema', { settingsSchema: [] }],
  ['tables', { tables: ['bad__name'] }],
  ['migrations', { migrations: ['002', '001'] }],
  ['migrations', { migrations: ['001'] }],
  ['events', { events: ['user.unknown'] }],
  ['interceptors', { interceptors: [{ name: 'user.register', priority: 1.5 }] }],
  ['interceptors', { interceptors: [{ name: 'unknown', priority: 1 }] }],
  [
    'providers',
    { providers: { passwordHasher: [{ id: 'test', label: 'test', detect: { pattern: '[' } }], login: [] } },
  ],
  [
    'routes',
    {
      routes: [
        { method: 'GET', path: '/:bad_name', auth: 'public', permission: null, maxBodyBytes: 0, rateLimit: null },
      ],
    },
  ],
  [
    'routes',
    { routes: [{ method: 'GET', path: '/', auth: 'user', permission: 'missing', maxBodyBytes: 0, rateLimit: null }] },
  ],
  [
    'routes',
    {
      routes: [
        {
          method: 'GET',
          path: '/',
          auth: 'public',
          permission: null,
          maxBodyBytes: 0,
          rateLimit: { by: 'user', limit: 1, windowSec: 1 },
        },
      ],
    },
  ],
  ['jobs', { jobs: [{ name: 'test', maxAttempts: 21, timeoutMs: 1 }] }],
  ['cron', { cron: [{ schedule: '* * * * *', job: 'missing', payload: {} }] }],
  [
    'ui',
    {
      ui: {
        pages: { test: { area: 'admin', title: 'test', view: { kind: 'stats', source: '/' } } },
        nav: [{ area: 'user', page: 'test', label: 'test', icon: 'test' }],
      },
    },
  ],
  [
    'ui',
    { ui: { pages: { test: { area: 'admin', title: 'test', view: { kind: 'stats', source: '/', extra: true } } } } },
  ],
  ['entry', { entry: { server: 'server.mjs', extra: true } }],
  ['integrity', { integrity: { 'server.mjs': 'A'.repeat(64) } }],
  ['extra', { extra: true }],
])('清单拒绝错误字段 %s', (field, patch) => {
  expect(() => parsePluginManifest({ ...base, ...patch })).toThrow(PluginPackageError)
  expect(() => parsePluginManifest({ ...base, ...patch })).toThrow(field)
})

test.each(['/../api', '/./x', '/a//b', '/a\\b', '/a#x', '/%2e%2e/api', '/a/%2F/b'])(
  '构建和安装都拒绝 UI 路径 %s',
  (source) => {
    const ui = {
      pages: {
        test: {
          area: 'admin' as const,
          title: 'test',
          view: {
            kind: 'table' as const,
            source: source as `/${string}`,
            columns: [],
            rowActions: [{ label: 'x', method: 'POST' as const, route: source as `/${string}` }],
          },
        },
      },
    }
    expect(() => buildManifest(definePlugin({ capabilities: [], ui }), pkg)).toThrow(/路径/)
    expect(() => parsePluginManifest({ ...base, ui })).toThrow(/ui/)
  },
)

test('UI 的 source/load/submit/action 路径逐项检查，并允许查询', () => {
  const form = (load: string, route: string) => ({
    pages: {
      test: {
        area: 'admin',
        title: 'test',
        view: { kind: 'form', fields: [], load, submit: { method: 'POST', route, label: 'x' } },
      },
    },
  })
  expect(() => parsePluginManifest({ ...base, ui: form('/x?scope=active', '/save?x=1') })).not.toThrow()
  for (const ui of [form('/../api', '/save'), form('/x', '/../api')])
    expect(() => parsePluginManifest({ ...base, ui })).toThrow(/ui/)
  for (const key of ['toolbar', 'rowActions']) {
    const ui = {
      pages: {
        test: {
          area: 'admin',
          title: 'test',
          view: {
            kind: 'table',
            source: '/',
            columns: [],
            [key]: [{ label: 'x', method: 'POST', route: '/../../api' }],
          },
        },
      },
    }
    expect(() => parsePluginManifest({ ...base, ui })).toThrow(/ui/)
  }
})

test.each([
  { type: 'select' },
  { type: 'select', options: [] },
  { type: 'select', options: [{ value: 'x', label: 'x' }], placeholder: 'x' },
  { type: 'boolean', placeholder: 'x' },
  { type: 'boolean', maxLength: 2 },
  { type: 'number', maxLength: 2 },
  { type: 'text', options: [] },
])('构建与安装都拒绝不匹配的 Field：%j', (properties) => {
  const ui = { formFields: [{ form: 'auth.register', field: { name: 'x', label: 'x', ...properties } }] }
  expect(() => buildManifest({ capabilities: [], ui } as never, pkg)).toThrow(/字段/)
  expect(() => parsePluginManifest({ ...base, ui })).toThrow(/ui/)
})

test('注册字段的 fromQuery 构建和安装都认，password、boolean 字段不能声明', () => {
  const text = { name: 'code', type: 'text', label: 'x' }
  const manifest = buildManifest(
    { capabilities: [], ui: { formFields: [{ form: 'auth.register', fromQuery: true, field: text }] } } as never,
    pkg,
  )
  expect(parsePluginManifest({ ...base, ui: manifest.ui }).ui.formFields).toEqual([
    { form: 'auth.register', fromQuery: true, field: text },
  ])
  for (const type of ['password', 'boolean']) {
    const ui = { formFields: [{ form: 'auth.register', fromQuery: true, field: { ...text, type } }] }
    expect(() => parsePluginManifest({ ...base, ui })).toThrow('fromQuery')
  }
})

test('安装时检查完整任务名的 128 字符上限', () => {
  const jobs = [{ name: 'x'.repeat(64), maxAttempts: 5, timeoutMs: 1000 }]
  expect(() => parsePluginManifest({ ...base, id: 'a'.repeat(52), jobs })).not.toThrow()
  expect(() => parsePluginManifest({ ...base, id: 'a'.repeat(53), jobs })).toThrow('128')
})

test('安装清单不接受 null 入口和不支持的设置控件', () => {
  expect(() => parsePluginManifest({ ...base, entry: { server: null } })).toThrow('entry.server')
  expect(() =>
    parsePluginManifest({
      ...base,
      settingsSchema: { type: 'object', properties: { x: { type: 'array', items: { type: 'number' } } } },
    }),
  ).toThrow('控件')
})
