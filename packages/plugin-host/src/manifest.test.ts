import { definePlugin, secret, table, type ThemeColor, type ThemeStructure } from '@nextskin/plugin-sdk'
import type { ThemeColorName, ThemeStructure as CoreThemeStructure } from '@nextskin/theme'
import { expect, expectTypeOf, test } from 'vitest'
import { z } from 'zod'
import sdkPackage from '@nextskin/plugin-sdk/package.json' with { type: 'json' }
import {
  buildManifest,
  describePlugin,
  PLUGIN_API_VERSION,
  pluginApiRange,
  PluginDefinitionError,
  pluginThemeIssues,
  type AnyPluginDefinition,
} from './manifest.ts'
import { satisfies } from './package/semver.ts'

const pkg = { name: '@test/example', version: '1.2.3', nextskin: { id: 'example' } }

/* eslint-disable nextskin/no-raw-color -- 主题校验的输入数据，需要覆盖合法色值和非法格式。 */
test('SDK 的公开颜色和核心可改颜色完全相同', () => {
  expectTypeOf<ThemeColor>().toEqualTypeOf<ThemeColorName>()
})

test('SDK 的公开结构和核心的键、取值完全相同', () => {
  expectTypeOf<ThemeStructure>().toEqualTypeOf<CoreThemeStructure>()
})

test('主题提取为小写，不修改定义，也不因配色失效拒绝提取', () => {
  const definition = definePlugin({
    capabilities: [],
    ui: {
      themes: [
        {
          name: 'cobalt',
          label: 'themes.cobalt',
          structure: { radius: 'square', borders: 'thick', cards: 'raised' },
          colors: { light: { accent: '#2A52E5' }, dark: { accent: '#86A2FF' } },
        },
        { name: 'empty', label: 'themes.empty', colors: {} },
        { name: 'invalid', label: 'themes.invalid', colors: { light: { accent: '#FFFFFF' } } },
      ],
    },
  })
  const manifest = buildManifest(definition, pkg)
  expect(manifest.ui.themes![0]!.colors).toEqual({ light: { accent: '#2a52e5' }, dark: { accent: '#86a2ff' } })
  expect(manifest.ui.themes![0]!.structure).toEqual({ radius: 'square', borders: 'thick', cards: 'raised' })
  expect(definition.ui!.themes![0]!.colors.light!.accent).toBe('#2A52E5')
  expect(pluginThemeIssues(manifest)).toEqual([
    {
      name: 'invalid',
      issues: expect.arrayContaining([
        expect.objectContaining({ mode: 'light', check: 'contrast', pair: ['accent-fg', 'accent'] }),
      ]) as unknown,
    },
  ])
  expect(pluginThemeIssues(buildManifest(definePlugin({ capabilities: [] }), pkg))).toEqual([])
})

test.each(
  [
    null,
    {},
    [null],
    [{ name: 'Bad', label: 'x', colors: {} }],
    [{ name: 'a--b', label: 'x', colors: {} }],
    [{ name: 'a'.repeat(33), label: 'x', colors: {} }],
    [{ name: 'a', colors: {} }],
    [{ name: 'a', label: 1, colors: {} }],
    [{ name: 'a', label: 'x' }],
    [{ name: 'a', label: 'x', colors: null }],
    [{ name: 'a', label: 'x', colors: [] }],
    [{ name: 'a', label: 'x', colors: { light: null } }],
    [{ name: 'a', label: 'x', colors: { dark: [] } }],
    [{ name: 'a', label: 'x', colors: { auto: {} } }],
    ...['stage', 'checker-a', 'checker-b', 'acent'].map((name) => [
      { name: 'a', label: 'x', colors: { light: { [name]: '#ffffff' } } },
    ]),
    ...['fff', '#fff', '#ffffffff', '#gggggg', '#ffffff\n', 'rgb(0 0 0)', 1, null].map((accent) => [
      { name: 'a', label: 'x', colors: { dark: { accent } } },
    ]),
    [{ name: 'a', label: 'x', colors: {}, extra: true }],
    Array.from({ length: 2 }, () => ({ name: 'same', label: 'x', colors: {} })),
    Array.from({ length: 17 }, (_, i) => ({ name: `theme-${i}`, label: 'x', colors: {} })),
  ].map((themes) => ({ themes })),
)('主题形状错误时拒绝提取：%j', ({ themes }) => {
  expect(() => describePlugin({ capabilities: [], ui: { themes } } as unknown as AnyPluginDefinition)).toThrow(
    /ui.themes/,
  )
})

test.each([null, [], { shadow: 'none' }, { radius: 'round' }, { borders: 'wide' }, { cards: 'floating' }])(
  '结构形状错误时拒绝提取并指出 structure：%j',
  (structure) => {
    expect(() =>
      buildManifest(
        {
          capabilities: [],
          ui: { themes: [{ name: 'a', label: 'themes.a', colors: {}, structure }] },
        } as unknown as AnyPluginDefinition,
        pkg,
      ),
    ).toThrow(/structure/)
  },
)

test('主题名 32 字符、16 套可用，未知 ui 项仍被拒绝', () => {
  const themes = Array.from({ length: 16 }, (_, i) => ({
    name: `${'a'.repeat(30)}${String(i).padStart(2, '0')}`,
    label: 'x',
    colors: {},
  }))
  expect(describePlugin(definePlugin({ capabilities: [], ui: { themes } })).ui.themes).toHaveLength(16)
  expect(() => describePlugin({ capabilities: [], ui: { unknown: [] } } as unknown as AnyPluginDefinition)).toThrow(
    'unknown',
  )
})

/* eslint-enable nextskin/no-raw-color */

test.each(['Bad', 'a_b', 'a--b', '../a', '1a', 'a-'])('buildManifest 拒绝非法 id %s', (id) => {
  expect(() => buildManifest(definePlugin({ capabilities: [] }), { ...pkg, nextskin: { id } })).toThrow(
    PluginDefinitionError,
  )
})

test.each([
  { routes: { 'GET /:bad_name': { auth: 'public', handler: () => Promise.resolve(new Response()) } } },
  { routes: { 'get /': { auth: 'public', handler: () => Promise.resolve(new Response()) } } },
  { tables: { bad__name: table<{ id: string }>() } },
  { cron: [{ schedule: '* * * * *', job: 'missing' }] },
  { intercept: { 'user.login': async () => {} } },
])('describePlugin 拒绝不合法声明：%j', (contributions) => {
  const definition = { capabilities: [], ...contributions } as unknown as AnyPluginDefinition
  expect(() => describePlugin(definition)).toThrow(PluginDefinitionError)
  expect(() => buildManifest(definition, pkg)).toThrow(PluginDefinitionError)
})

test('manifest 提取默认值、排序迁移和机密设置的 writeOnly', () => {
  const definition = definePlugin({
    capabilities: ['storage.tables'],
    tables: { codes: table<{ code: string }>() },
    migrations: { '002': { up: async () => {} }, '001': { up: async () => {} } },
    settings: z.object({ token: secret(), enabled: z.boolean().default(true) }),
    routes: { 'GET /codes/:code': { auth: 'public', handler: () => Promise.resolve(new Response()) } },
    jobs: { refresh: { handler: async () => {} } },
    intercept: { 'user.register': async () => {} },
    cron: [{ schedule: '0 * * * *', job: 'refresh' }],
    on: { 'user.registered': async () => {} },
  })
  const manifest = buildManifest(definition, pkg)
  expect(manifest).toMatchObject({
    manifestVersion: 1,
    id: 'example',
    version: '1.2.3',
    api: pluginApiRange(PLUGIN_API_VERSION),
    capabilities: ['storage.tables'],
    tables: ['codes'],
    migrations: ['001', '002'],
    routes: [
      {
        method: 'GET',
        path: '/codes/:code',
        auth: 'public',
        permission: null,
        maxBodyBytes: 1024 * 1024,
        rateLimit: null,
      },
    ],
    jobs: [{ name: 'refresh', maxAttempts: 5, timeoutMs: 60_000 }],
    interceptors: [{ name: 'user.register', priority: 100 }],
    events: ['user.registered'],
    cron: [{ schedule: '0 * * * *', job: 'refresh', payload: {} }],
    settingsSchema: { properties: { token: { type: 'string', writeOnly: true }, enabled: { default: true } } },
    entry: { server: null },
    integrity: {},
  })
  expect(describePlugin(definition).routes).toEqual(manifest.routes)
})

test('插件 API 版本就是 SDK 的版本号；api 取到次版本，预发布版本取完整版本号', () => {
  expect(PLUGIN_API_VERSION).toBe(sdkPackage.version)
  expect(pluginApiRange('1.3.2')).toBe('^1.3.0')
  expect(pluginApiRange('2.0.0')).toBe('^2.0.0')
  expect(pluginApiRange('1.0.0-rc.1')).toBe('^1.0.0-rc.1')
  expect(() => pluginApiRange('1.0')).toThrow()
  // 用补丁版本构建的插件装得上同一个次版本的核心；预发布版本之间、预发布到正式版都满足
  expect(satisfies('1.3.0', pluginApiRange('1.3.2'))).toBe(true)
  expect(satisfies('1.2.9', pluginApiRange('1.3.0'))).toBe(false)
  expect(satisfies('1.0.0-rc.2', pluginApiRange('1.0.0-rc.1'))).toBe(true)
  expect(satisfies('1.0.0', pluginApiRange('1.0.0-rc.1'))).toBe(true)
  expect(satisfies('2.0.0', pluginApiRange('1.0.0'))).toBe(false)
  expect(satisfies(PLUGIN_API_VERSION, buildManifest(definePlugin({ capabilities: [] }), pkg).api)).toBe(true)
})

test('定时任务只给 undefined 补默认载荷，保留 null', () => {
  const manifest = buildManifest(
    definePlugin({
      capabilities: [],
      jobs: { tick: { handler: async () => {} } },
      cron: [
        { schedule: '* * * * *', job: 'tick' },
        { schedule: '* * * * *', job: 'tick', payload: null },
      ],
    }),
    pkg,
  )
  expect(manifest.cron.map((entry) => entry.payload)).toEqual([{}, null])
})

test('构建时拒绝超过入队上限的完整任务名，边界长度可用', () => {
  const definition = definePlugin({ capabilities: [], jobs: { ['x'.repeat(64)]: { handler: async () => {} } } })
  expect(buildManifest(definition, { ...pkg, nextskin: { id: 'a'.repeat(52) } }).jobs).toHaveLength(1)
  expect(() => buildManifest(definition, { ...pkg, nextskin: { id: 'a'.repeat(53) } })).toThrow('128')
})

test.each(['1.0.0+build', '1.0.0-rc.1+build'])('构建和安装共用 semver，接受 %s', (version) => {
  expect(buildManifest(definePlugin({ capabilities: [] }), { ...pkg, version }).version).toBe(version)
})

test.each(['01.0.0', '1.0.0-01', '1.0.0\n'])('构建拒绝非法版本 %s', (version) => {
  expect(() => buildManifest(definePlugin({ capabilities: [] }), { ...pkg, version })).toThrow('semver')
})

test.each([
  z.object({ bad: z.array(z.number()) }),
  z.object({ bad: z.object({ nested: z.object({ value: z.string() }) }) }),
  z.object({ bad: z.object({ token: secret() }) }),
])('构建时检查设置能否映射到控件', (settings) => {
  expect(() => buildManifest(definePlugin({ capabilities: [], settings }), pkg)).toThrow(/控件|机密/)
})

test.each(['text', 'textarea', 'number', 'select', 'password', 'boolean'])(
  '注册字段 %s 校验 fromQuery 的类型和可用性',
  (type) => {
    const field = {
      type,
      name: 'code',
      label: 'field',
      ...(type === 'select' ? { options: [{ value: 'a', label: 'a' }] } : {}),
    }
    const describe = (item: unknown) =>
      describePlugin({ capabilities: [], ui: { formFields: [item] } } as AnyPluginDefinition)
    for (const fromQuery of [undefined, false, true]) {
      const item = { form: 'auth.register', field, ...(fromQuery === undefined ? {} : { fromQuery }) }
      if (fromQuery === true && ['password', 'boolean'].includes(type))
        expect(() => describe(item)).toThrow('fromQuery')
      else expect(describe(item).ui.formFields).toEqual([item])
    }
    for (const fromQuery of [null, 1, 'true'])
      expect(() => describe({ form: 'auth.register', field, fromQuery })).toThrow('fromQuery')
    expect(() => describe({ form: 'auth.register', field, unknown: true })).toThrow('formFields')
  },
)

const widget = {
  name: 'summary',
  slot: 'user.dashboard',
  title: 'widget.title',
  view: { kind: 'stats', source: '/stats?scope=mine' },
} as const
const widgetPages = {
  home: { area: 'user', title: 'page.home', view: { kind: 'markdown', source: '/' } },
  admin: { area: 'admin', title: 'page.admin', view: { kind: 'stats', source: '/stats' } },
} as const

test('两个插槽各允许两个挂件，保留权限、链接和两种视图', () => {
  const widgets = [
    { ...widget, permission: 'manage' as const, link: { page: 'home', label: 'widget.manage' } },
    { ...widget, name: 'a'.repeat(64), view: { kind: 'markdown' as const, source: '/' as const } },
    {
      ...widget,
      name: 'admin',
      slot: 'admin.dashboard' as const,
      permission: 'manage' as const,
      link: { page: 'admin', label: 'widget.manage' },
    },
    {
      ...widget,
      name: 'admin-help',
      slot: 'admin.dashboard' as const,
      view: { kind: 'markdown' as const, source: '/' as const },
    },
  ]
  const ui = { pages: widgetPages, widgets }
  expect(
    describePlugin(definePlugin({ capabilities: [], permissions: { manage: 'permission.manage' }, ui })).ui,
  ).toEqual(ui)
})

test.each(
  [
    null,
    {},
    [null],
    [1],
    [{ ...widget, extra: true }],
    ...[undefined, null, 1, '', 'Bad', 'a_b', '1a', 'a'.repeat(65), 'a\n'].map((name) => [{ ...widget, name }]),
    [widget, widget],
    [widget, { ...widget, slot: 'admin.dashboard' }],
    ...[undefined, null, 1, 'user.dashbord', 'admin', 'toString'].map((slot) => [{ ...widget, slot }]),
    ...[undefined, null, 1].map((title) => [{ ...widget, title }]),
    ...[undefined, null, {}, { kind: 'table', source: '/', columns: [] }, { kind: 'form', fields: [] }].map((view) => [
      { ...widget, view },
    ]),
    [{ ...widget, view: { ...widget.view, extra: true } }],
    ...[undefined, null, 1, 'relative', '/../api', '/./x', '/a//b', '/a\\b', '/a#x', '/%2e%2e/api', '/a/%2F/b'].map(
      (source) => [{ ...widget, view: { ...widget.view, source } }],
    ),
    ...['missing', null, 1].map((permission) => [{ ...widget, permission }]),
    ...[
      null,
      {},
      { page: 'missing', label: 'x' },
      { page: 'toString', label: 'x' },
      { page: 'admin', label: 'x' },
      { page: 'home' },
      { page: 'home', label: 1 },
      { page: 'home', label: 'x', extra: true },
    ].map((link) => [{ ...widget, link }]),
    [{ ...widget, slot: 'admin.dashboard', link: { page: 'home', label: 'x' } }],
    ...['user.dashboard', 'admin.dashboard'].map((slot) =>
      Array.from({ length: 3 }, (_, i) => ({ ...widget, name: `summary-${i}`, slot })),
    ),
  ].map((widgets) => ({ widgets })),
)('拒绝不合法的挂件声明：%j', ({ widgets }) => {
  expect(() =>
    describePlugin({
      capabilities: [],
      permissions: { manage: 'permission.manage' },
      ui: { pages: widgetPages, widgets },
    } as unknown as AnyPluginDefinition),
  ).toThrow(/挂件|widgets/)
})
