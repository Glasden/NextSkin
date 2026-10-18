import { buildManifest } from '@nextskin/plugin-host'
import { expect, test } from 'vitest'
import { normalizeCode, randomCode } from './index.ts'
import plugin from './official.ts'

test('manifest 能从定义里提取出来', () => {
  const manifest = buildManifest(plugin.definition, plugin.package)
  expect(manifest).toMatchObject({
    id: 'invitation-codes',
    capabilities: ['storage.tables'],
    tables: ['codes'],
    migrations: ['0001_create_codes'],
    events: ['user.registered'],
    interceptors: [{ name: 'user.register', priority: 100 }],
    permissions: { manage: 'permission.manage' },
  })
  expect(manifest.routes.map((route) => `${route.method} ${route.path} ${route.permission}`)).toEqual([
    'GET /codes manage',
    'POST /codes manage',
    'DELETE /codes/:code manage',
  ])
})

test('界面上用到的文案键两种语言都有', () => {
  const manifest = buildManifest(plugin.definition, plugin.package)
  const keys = new Set<string>(
    JSON.stringify(manifest.ui)
      .match(/"(?:label|title|help|confirm|placeholder)":"([^"]+)"/g)
      ?.map((m) => m.split('":"')[1]!.slice(0, -1)) ?? [],
  )
  keys.add('error.invalidCode')
  for (const messages of Object.values(plugin.messages))
    for (const key of keys) {
      const value = key
        .split('.')
        .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], messages)
      expect(typeof value, key).toBe('string')
    }
})

test('邀请码：12 位，不含容易看错的字符；输入时忽略大小写、空白和连字符', () => {
  const code = randomCode()
  expect(code).toMatch(/^[A-HJ-NP-Z2-9]{12}$/)
  expect(normalizeCode(` ${code.slice(0, 4).toLowerCase()}-${code.slice(4)} `)).toBe(code)
})
