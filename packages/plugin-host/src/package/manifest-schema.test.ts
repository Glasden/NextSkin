import { expect, test } from 'vitest'
import { definePlugin } from '@nextskin/plugin-sdk'
import invitation from '../../../../plugins/invitation-codes/src/official.ts'
import cdn from '../../../../plugins/cdn-refresh/src/official.ts'
import invitationExample from '../../../plugin-sdk/examples/invitation-codes/index.ts'
import cdnExample from '../../../plugin-sdk/examples/cdn-refresh/index.ts'
import authmeExample from '../../../plugin-sdk/examples/authme-hasher/index.ts'
import { buildManifest } from '../manifest.ts'
import { parsePluginManifest } from './manifest-schema.ts'
import { PluginPackageError } from './error.ts'

const pkg = { name: 'test', version: '1.0.0', nextskin: { id: 'test' } }
const base = buildManifest(definePlugin({ capabilities: [] }), pkg)

test('官方插件与三个 SDK 示例的清单都能通过严格校验', () => {
  const manifests = [
    buildManifest(invitation.definition, invitation.package),
    buildManifest(cdn.definition, cdn.package),
    ...[invitationExample, cdnExample, authmeExample].map((definition) => buildManifest(definition, pkg)),
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
