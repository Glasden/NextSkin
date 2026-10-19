/** 上传、安装、卸载插件包和重启 plugin host 的 REST 接口（ADR-0033"安装"） */
import { MAX_PACKAGE_BYTES } from '@nextskin/plugin-host'
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { buildPackage, hostEntry, pluginPackages } from '../../../domain/src/plugins/host.test-helper.ts'
import { official, pluginEnvironment } from '../../../domain/src/plugins/plugins.test-helper.ts'
import { definePlugin } from '../../../plugin-sdk/src/index.ts'
import { createApp } from '../app.ts'
import { errorSchema } from './errors.ts'
import { MAX_PLUGIN_PACKAGE_REQUEST_BYTES } from './plugins.ts'

const env = pluginEnvironment()
const origin = 'https://skin.example.test'
let app: ReturnType<typeof createApp>
let session: Awaited<ReturnType<typeof env.core.auth.getSessionUser>>
let actor: Awaited<ReturnType<typeof env.actor>>
const source = `
import { definePlugin } from '@nextskin/plugin-sdk'
export default definePlugin({ capabilities: ['storage.kv'] })
`
const routed = `
import { definePlugin } from '@nextskin/plugin-sdk'
export default definePlugin({
  capabilities: [],
  routes: { 'GET /ping': { auth: 'public', handler: async () => new Response('pong') } },
})
`

// 打插件包要起一个构建进程，负载高时（Windows 上的 pnpm check）要好几秒：先打好，测试里取缓存
beforeAll(async () => {
  await Promise.all([
    buildPackage({ id: 'probe', source }),
    buildPackage({ id: 'official', source }),
    buildPackage({ id: 'probe', source: routed }),
  ])
}, 60_000)

beforeEach(async () => {
  await env.boot([official('official', definePlugin({ capabilities: [] }))], {
    plugins: { host: hostEntry, packages: (await pluginPackages()).packages },
  })
  actor = await env.actor()
  session = { uid: actor.uid, role: 'superadmin', nickname: 'Session', email: 'session@example.test', locale: null }
  vi.spyOn(env.core.auth, 'getSessionUser').mockImplementation(() => Promise.resolve(session))
  app = createApp({ core: env.core })
})
afterEach(() => vi.restoreAllMocks())

function send(method: string, path: string, body?: FormData | string, headers: Record<string, string> = {}) {
  return app.request(
    `${origin}/api${path}`,
    {
      method,
      headers: {
        host: 'skin.example.test',
        'x-forwarded-proto': 'https',
        cookie: 'session=example',
        origin,
        ...headers,
      },
      ...(body === undefined ? {} : { body }),
    },
    { peer: '192.0.2.10' },
  )
}

function form(file: Uint8Array | Blob, packageHash?: string) {
  const body = new FormData()
  body.set('file', file instanceof Blob ? file : new Blob([file]), 'plugin.tgz')
  if (packageHash !== undefined) body.set('packageHash', packageHash)
  return body
}

async function failure(response: Response, status: number, code: string) {
  expect(response.status).toBe(status)
  const result = errorSchema.parse(await response.json())
  expect(result.error.code).toBe(code)
  return result.error
}

const audits = () => env.db.selectFrom('audit_logs').select(['action', 'ip', 'details']).orderBy('id').execute()

test('预览之后确认安装：返回 manifest 和 packageHash，装好的插件停用着，审计记下能力', async () => {
  const bytes = await buildPackage({ id: 'probe', source })
  const preview = await send('POST', '/admin/plugin-packages/preview', form(bytes))
  expect(preview.status).toBe(200)
  const body = (await preview.json()) as { packageHash: string }
  expect(body).toMatchObject({
    action: 'install',
    previous: null,
    highRisk: [],
    manifest: { id: 'probe', version: '1.0.0', capabilities: ['storage.kv'] },
    packageHash: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
  })
  expect(await audits()).toEqual([])

  const installed = await send('POST', '/admin/plugin-packages', form(bytes, body.packageHash))
  expect(installed.status).toBe(201)
  expect(await installed.json()).toEqual({ id: 'probe', version: '1.0.0', action: 'install' })
  expect(await env.db.selectFrom('plugins').select(['id', 'is_enabled', 'package_hash']).execute()).toEqual([
    { id: 'probe', is_enabled: 0, package_hash: body.packageHash },
  ])
  expect((await audits()).map((row) => ({ ...row, details: JSON.parse(row.details) as unknown }))).toEqual([
    {
      action: 'plugin.install',
      ip: '192.0.2.10',
      details: {
        plugin: 'probe',
        version: '1.0.0',
        packageHash: body.packageHash,
        capabilities: ['storage.kv'],
        network: [],
      },
    },
  ])

  // 再传同一个版本：不能覆盖
  await failure(await send('POST', '/admin/plugin-packages/preview', form(bytes)), 409, 'plugin_version_not_newer')
})

test('确认时传来的包和预览的不是同一个：409，什么也不写', async () => {
  const bytes = await buildPackage({ id: 'probe', source })
  await failure(
    await send('POST', '/admin/plugin-packages', form(bytes, '0'.repeat(64))),
    409,
    'plugin_package_changed',
  )
  await failure(await send('POST', '/admin/plugin-packages', form(bytes, 'not-a-hash')), 400, 'invalid_request')
  expect(await env.db.selectFrom('plugins').selectAll().execute()).toEqual([])
  expect(await audits()).toEqual([])
})

// 错误文案按 reason 选（i18n 的 select），这里用文案里的关键字区分
test.each([
  ['不是 gzip', new Uint8Array([1, 2, 3]), /nextskin-plugin build/],
  ['超过 10 MiB', new Uint8Array(MAX_PACKAGE_BYTES + 1), /10 MiB/],
  ['整个请求超过上限', new Uint8Array(MAX_PLUGIN_PACKAGE_REQUEST_BYTES + 1), /10 MiB/],
] as const)('拒绝不合格的插件包：%s', async (_, bytes, message) => {
  const error = await failure(
    await send('POST', '/admin/plugin-packages/preview', form(bytes)),
    400,
    'plugin_package_invalid',
  )
  expect(error.message).toMatch(message)
})

test('官方插件的 id 不能安装，官方插件也不能卸载', async () => {
  const bytes = await buildPackage({ id: 'official', source })
  await failure(await send('POST', '/admin/plugin-packages/preview', form(bytes)), 409, 'plugin_id_reserved')
  await failure(await send('DELETE', '/admin/plugins/official'), 400, 'plugin_official')
  await failure(await send('DELETE', '/admin/plugins/missing'), 404, 'plugin_not_found')
})

test('上传接口只收 multipart', async () => {
  for (const path of ['/admin/plugin-packages/preview', '/admin/plugin-packages']) {
    const response = await send('POST', path, JSON.stringify({ file: 'x' }), { 'content-type': 'application/json' })
    await failure(response, 415, 'invalid_request')
  }
})

const operations = [
  ['POST', '/admin/plugin-packages/preview', () => form(new Uint8Array([1]))],
  ['POST', '/admin/plugin-packages', () => form(new Uint8Array([1]), '0'.repeat(64))],
  ['DELETE', '/admin/plugins/official', () => undefined],
  ['POST', '/admin/plugin-host/restart', () => undefined],
] as const

test.each(operations)('%s %s：管理员 403，未登录 401，跨站 403', async (method, path, body) => {
  const admin = await env.actor('admin')
  session = { ...session!, uid: admin.uid }
  await failure(await send(method, path, body()), 403, 'permission_denied')
  session = null
  await failure(await send(method, path, body()), 401, 'unauthenticated')
  session = { ...session!, uid: actor.uid, role: 'superadmin', nickname: 'S', email: 's@example.test', locale: null }
  await failure(await send(method, path, body(), { origin: 'https://other.test' }), 403, 'invalid_origin')
  expect(await audits()).toEqual([])
})

test('卸载安装的插件和重启 host 都写审计', async () => {
  const bytes = await buildPackage({ id: 'probe', source })
  const { packageHash } = await env.core.plugins.admin.preview(actor, bytes)
  await env.core.plugins.admin.install(actor, bytes, packageHash)
  await env.db.deleteFrom('audit_logs').execute()

  expect((await send('POST', '/admin/plugin-host/restart')).status).toBe(200)
  const removed = await send('DELETE', '/admin/plugins/probe')
  expect(removed.status).toBe(200)
  expect(await removed.json()).toEqual({ ok: true })
  expect(env.core.plugins.get('probe')).toBeUndefined()
  expect((await audits()).map((row) => ({ ...row, details: JSON.parse(row.details) as unknown }))).toEqual([
    { action: 'plugin.restartHost', ip: '192.0.2.10', details: {} },
    { action: 'plugin.uninstall', ip: '192.0.2.10', details: { plugin: 'probe', version: '1.0.0', wasEnabled: false } },
  ])
})

test('启用了、本实例上却取不到包的插件：HTTP 上它的路由返回 503，不是 404', async () => {
  const bytes = await buildPackage({ id: 'probe', source: routed })
  const { packageHash } = await env.core.plugins.admin.preview(actor, bytes)
  await env.core.plugins.admin.install(actor, bytes, packageHash)
  await env.core.plugins.admin.enable(actor, 'probe')
  const ping = () =>
    app.request(
      `${origin}/plugins/probe/ping`,
      { headers: { host: 'skin.example.test', 'x-forwarded-proto': 'https' } },
      { peer: '192.0.2.10' },
    )
  expect(await (await ping()).text()).toBe('pong')

  // 别的实例升级了它，本实例取不到新版本的包
  await env.db
    .updateTable('plugins')
    .set({ version: '1.1.0', package_hash: 'f'.repeat(64) })
    .where('id', '=', 'probe')
    .execute()
  await env.core.plugins.sync()
  await failure(await ping(), 503, 'plugin_unavailable')
})
