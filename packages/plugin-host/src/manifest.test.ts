import { definePlugin, secret, table } from '@nextskin/plugin-sdk'
import { expect, test } from 'vitest'
import { z } from 'zod'
import sdkPackage from '@nextskin/plugin-sdk/package.json' with { type: 'json' }
import {
  buildManifest,
  describePlugin,
  PLUGIN_API_VERSION,
  pluginApiRange,
  PluginDefinitionError,
  type AnyPluginDefinition,
} from './manifest.ts'
import { satisfies } from './package/semver.ts'

const pkg = { name: '@test/example', version: '1.2.3', nextskin: { id: 'example' } }

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
