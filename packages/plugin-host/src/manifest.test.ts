import { definePlugin, secret, table } from '@nextskin/plugin-sdk'
import { expect, test } from 'vitest'
import { z } from 'zod'
import { buildManifest, describePlugin, PluginDefinitionError, type AnyPluginDefinition } from './manifest.ts'

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
    api: '^1.0.0',
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
