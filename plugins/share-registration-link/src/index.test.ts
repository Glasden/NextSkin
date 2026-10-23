import { buildManifest } from '@nextskin/plugin-host'
import { expect, test } from 'vitest'
import { normalizeCode, randomCode, registerLink } from './index.ts'
import plugin from './official.ts'

test('manifest 能从定义里提取出来，注册字段声明了 fromQuery', () => {
  const manifest = buildManifest(plugin.definition, plugin.package)
  expect(manifest).toMatchObject({
    id: 'share-registration-link',
    capabilities: ['storage.tables', 'users.score'],
    tables: ['codes', 'rewards'],
    migrations: ['0001_create_tables'],
    events: ['user.registered', 'user.deleted'],
    interceptors: [],
  })
  expect(manifest.ui.widgets).toEqual([
    {
      name: 'share',
      slot: 'user.dashboard',
      title: 'widget.title',
      link: { page: 'links', label: 'widget.manage' },
      view: { kind: 'markdown', source: '/widget' },
    },
  ])
  expect(manifest.routes.find(({ path }) => path === '/widget')).toMatchObject({ auth: 'user', rateLimit: null })
  expect(manifest.ui.formFields?.map(({ form, fromQuery, field }) => ({ form, fromQuery, name: field.name }))).toEqual([
    { form: 'auth.register', fromQuery: true, name: 'code' },
  ])
  expect(manifest.routes.map((route) => `${route.method} ${route.path} ${route.auth}`)).toEqual([
    'GET /widget user',
    'GET /codes user',
    'POST /codes user',
    'DELETE /codes/:code user',
  ])
})

test('分享码：16 位，用户输入时忽略大小写、空白和连字符', () => {
  const code = randomCode()
  expect(code).toMatch(/^[A-HJ-NP-Z2-9]{16}$/)
  expect(normalizeCode(` ${code.slice(0, 8).toLowerCase()}-${code.slice(8)} `)).toBe(code)
})

test('注册链接保留站点地址的路径，参数名带插件 id', () => {
  expect(registerLink('https://skin.example.test', 'share-registration-link', 'ABC')).toBe(
    'https://skin.example.test/sign-up?share-registration-link.code=ABC',
  )
  expect(registerLink('https://example.test/skin/', 'host-share-registration-link', 'ABC')).toBe(
    'https://example.test/skin/sign-up?host-share-registration-link.code=ABC',
  )
})
