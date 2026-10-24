/**
 * 安装插件在 plugin host 里运行（ADR-0033"测试 / host"）：安装、启用、升级、卸载；
 * 读不到 .env、数据目录和 SQLite 文件；崩溃后重启；换代时在途的请求能完成；manifest 和实际定义对不上时停在旧的一代。
 */
import { createServer } from 'node:http'
import { mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { packPluginPackage, unpackPluginPackage } from '@nextskin/plugin-host'
import { definePlugin } from '@nextskin/plugin-sdk'
import { toIsoTimestamp } from '@nextskin/db'
import { expect, test, vi } from 'vitest'
import { createCore } from '../core.ts'
import { PLUGIN_CLEANUP_JOB, type PluginRouteRequest } from './system.ts'
import { hostNetworkRestricted } from './host.ts'
import { buildPackage, hostEntry, pluginPackages } from './host.test-helper.ts'
import { createLocalPluginPackageStore, createPluginPackages } from './packages.ts'
import { official, pluginEnvironment } from './plugins.test-helper.ts'

const env = pluginEnvironment()

/** 一个探针插件：路由报告版本、慢请求、崩溃，以及 host 进程的权限 */
const probe = (version: string, extra = '') => `
import { readFileSync } from 'node:fs'
import { definePlugin } from '@nextskin/plugin-sdk'

export default definePlugin({
  capabilities: [${extra}],
  routes: {
    'GET /version': { auth: 'public', handler: async () => new Response('${version}') },
    'GET /slow': {
      auth: 'public',
      handler: async () => {
        await new Promise((resolve) => setTimeout(resolve, 500))
        return new Response('slow ${version}')
      },
    },
    'GET /crash': {
      auth: 'public',
      handler: async () => {
        process.exit(3)
      },
    },
    'GET /sandbox': {
      auth: 'public',
      handler: async ({ request }) => {
        const url = new URL(request.url)
        const reads = {}
        for (const path of url.searchParams.getAll('path')) {
          try {
            readFileSync(path)
            reads[path] = 'ok'
          } catch (error) {
            reads[path] = error.code ?? error.name
          }
        }
        let network = 'skipped'
        const target = url.searchParams.get('net')
        if (target) {
          try {
            await fetch(target)
            network = 'ok'
          } catch (error) {
            network = error.cause?.code ?? error.code ?? error.name
          }
        }
        return Response.json({ env: { ...process.env }, reads, network })
      },
    },
  },
})
`

function route(pluginId: string, path: string, user: { uid: number } | null = null): PluginRouteRequest {
  return {
    pluginId,
    method: 'GET',
    path: path.split('?')[0]!,
    request: { method: 'GET', url: `https://skin.example.test/plugins/${pluginId}${path}`, headers: [], body: null },
    user: user ? { uid: user.uid, role: 'superadmin' } : null,
    ip: '192.0.2.1',
    locale: 'en',
  }
}

const text = (body: Uint8Array | null) => (body ? new TextDecoder().decode(body) : '')

async function boot(options: { maxCrashes?: number; fetch?: typeof fetch } = {}) {
  const storage = await pluginPackages()
  await env.boot([], {
    plugins: {
      fetch: options.fetch,
      host: hostEntry,
      packages: storage.packages,
      hostRestart: { baseDelayMs: 50, maxCrashes: options.maxCrashes ?? 5 },
    },
  })
  return storage
}

async function install(bytes: Uint8Array, actor: { uid: number; ip: string }) {
  const preview = await env.core.plugins.admin.preview(actor, bytes)
  await env.core.plugins.admin.install(actor, bytes, preview.packageHash)
  return preview
}

async function until(check: () => boolean, timeoutMs = 10_000) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待超时')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test('邀请码在 plugin host 里运行：安装、启用，注册时的拦截器、路由和事件', async () => {
  await boot()
  const actor = await env.actor()
  const bytes = await buildPackage({ id: 'invitation-codes', from: 'plugins/invitation-codes' })
  const preview = await install(bytes, actor)
  expect(preview).toMatchObject({ action: 'install', previous: null, manifest: { id: 'invitation-codes' } })
  expect(preview.messages['zh-CN']).toMatchObject({ plugin: { name: expect.any(String) as unknown } })
  expect(await env.core.plugins.admin.list(actor)).toEqual([
    expect.objectContaining({ id: 'invitation-codes', official: false, enabled: false, running: false }),
  ])

  await env.core.plugins.admin.enable(actor, 'invitation-codes')
  expect(env.core.plugins.hostStatus()).toMatchObject({ state: 'running', plugins: ['invitation-codes'] })
  expect(env.core.plugins.isRunning('invitation-codes')).toBe(true)

  // 事务内的拦截器：没有码时拒绝，用户没建出来
  await expect(
    env.core.users.register(env.input({ plugins: { 'invitation-codes': { code: 'NOPE' } } })),
  ).rejects.toMatchObject({
    code: 'registration_denied',
    params: { plugin: 'invitation-codes', reason: 'invalid_code' },
  })
  const generated = await env.core.plugins.route({
    ...route('invitation-codes', '/codes', actor),
    method: 'POST',
    request: {
      method: 'POST',
      url: 'https://skin.example.test/plugins/invitation-codes/codes',
      headers: [['content-type', 'application/json']],
      body: new TextEncoder().encode(JSON.stringify({ count: 1 })),
    },
  })
  expect(generated.status).toBe(201)
  const [row] = await env.db
    .withTables<{ p_invitation_codes__codes: { code: string; used_by: number | null } }>()
    .selectFrom('p_invitation_codes__codes')
    .selectAll()
    .execute()
  const result = await env.core.users.register(env.input({ plugins: { 'invitation-codes': { code: row!.code } } }))
  // user.registered 事件交给 host 里的插件，把用户记到码上
  await env.core.jobs.drain()
  expect(
    await env.db
      .withTables<{ p_invitation_codes__codes: { code: string; used_by: number | null } }>()
      .selectFrom('p_invitation_codes__codes')
      .select('used_by')
      .executeTakeFirstOrThrow(),
  ).toEqual({ used_by: result.uid })
})

test('AuthMe 密码在 plugin host 里运行：安装时列为高风险，启用后认领 AuthMe 的哈希，启动器登录后换成当前算法', async () => {
  await boot()
  const actor = await env.actor()
  const preview = await install(await buildPackage({ id: 'authme-password', from: 'plugins/authme-password' }), actor)
  expect(preview.highRisk).toEqual(['provider.passwordHasher'])
  // AuthMe 自己的测试向量，密码都是 password
  const sha256 = '$SHA$11aa0706173d7272$dbba96681c2ae4e0bfdf226d70fbbc5e4ee3d8071faa613bc533fe8a64817d10'
  const salted = '$authme$salted2md5$9b5f5749$9f3d13dc01a6fe61fd669954174399f3'
  expect(await env.core.plugins.verifyPassword({ hash: sha256, password: 'password' })).toBe(false)

  await env.core.plugins.admin.enable(actor, 'authme-password')
  expect(env.core.plugins.isRunning('authme-password')).toBe(true)
  expect(await env.core.plugins.verifyPassword({ hash: salted, password: 'password' })).toBe(true)
  expect(await env.core.plugins.verifyPassword({ hash: salted, password: 'PassWord1' })).toBe(false)

  const input = env.input()
  const { uid } = await env.core.users.register(input)
  await env.db.updateTable('accounts').set({ password: sha256 }).where('user_id', '=', uid).execute()
  const response = await env.core.yggdrasil.authenticate({
    username: input.email,
    password: 'password',
    rawPassword: 'password',
    clientToken: null,
    requestUser: false,
  })
  expect(response.accessToken).toBeTruthy()
  const { password } = await env.db
    .selectFrom('accounts')
    .select('password')
    .where('user_id', '=', uid)
    .executeTakeFirstOrThrow()
  expect(password).not.toBe(sha256)
  expect(password).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/)
})

test('host 读不到 .env、数据目录和数据库文件，环境变量为空；Node 25 起也不能直接连网', async () => {
  const storage = await boot()
  const actor = await env.actor()
  await install(await buildPackage({ id: 'probe', source: probe('1') }), actor)
  await env.core.plugins.admin.enable(actor, 'probe')
  const secrets = join(storage.dir, '.env')
  await writeFile(secrets, 'NEXTSKIN_SECRET=do-not-read')
  const server = createServer((_, response) => response.end('reached'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    // 数据目录里的插件包、.env 和数据库文件都读不到；host 能读的只有自己的代码和解开的插件目录
    const [stored] = await readdir(join(storage.dir, 'plugin-packages'))
    const paths = [
      secrets,
      join(storage.dir, 'plugin-packages', stored!),
      ...(env.databaseFile ? [env.databaseFile] : []),
    ]
    const query = new URLSearchParams([
      ...paths.map((path): [string, string] => ['path', path]),
      ['net', `http://127.0.0.1:${(server.address() as AddressInfo).port}/`],
    ])
    const response = await env.core.plugins.route(route('probe', `/sandbox?${query.toString()}`))
    const report = JSON.parse(text(response.body)) as { env: object; reads: Record<string, string>; network: string }
    // Windows 上只留 SYSTEMROOT（main.ts）
    expect(Object.keys(report.env)).toEqual(process.platform === 'win32' ? ['SYSTEMROOT'] : [])
    for (const path of paths) expect(report.reads[path]).toBe('ERR_ACCESS_DENIED')
    if (hostNetworkRestricted) expect(report.network).toBe('ERR_ACCESS_DENIED')
  } finally {
    server.close()
  }
})

test('升级：实际的定义和 manifest 对不上时停在旧的一代；正常的新版本列出新增的能力，切换后用新代码', async () => {
  await boot()
  const actor = await env.actor()
  await install(await buildPackage({ id: 'probe', source: probe('1') }), actor)
  await env.core.plugins.admin.enable(actor, 'probe')
  const first = env.core.plugins.hostStatus().generation

  // manifest 里多一个代码没有订阅的事件：新一代的健康检查失败，当前这一代照常运行
  const good = await buildPackage({ id: 'probe', version: '1.1.0', source: probe('2', "'storage.kv'") })
  const unpacked = unpackPluginPackage(good)
  const tampered = packPluginPackage({
    manifest: { ...unpacked.manifest, events: ['user.deleted'] },
    files: new Map([...unpacked.files].filter(([path]) => path !== 'manifest.json')),
  })
  await expect(install(tampered, actor)).rejects.toMatchObject({ code: 'plugin_load_failed' })
  expect(env.core.plugins.hostStatus()).toMatchObject({ state: 'running', generation: first })
  expect(text((await env.core.plugins.route(route('probe', '/version'))).body)).toBe('1')
  expect((await env.core.plugins.admin.detail(actor, 'probe')).lastError).toMatch(/load_failed/)

  const preview = await env.core.plugins.admin.preview(actor, good)
  expect(preview).toMatchObject({
    action: 'upgrade',
    previous: { version: '1.0.0', enabled: true, addedCapabilities: ['storage.kv'], addedNetwork: [] },
  })
  await env.core.plugins.admin.install(actor, good, preview.packageHash)
  expect(env.core.plugins.hostStatus().generation).toBeGreaterThan(first!)
  expect(text((await env.core.plugins.route(route('probe', '/version'))).body)).toBe('2')
  expect(await env.core.plugins.admin.detail(actor, 'probe')).toMatchObject({ version: '1.1.0', lastError: null })
  // 不能降级，也不能用同一个版本号换内容
  await expect(env.core.plugins.admin.preview(actor, good)).rejects.toMatchObject({
    code: 'plugin_version_not_newer',
  })
})

test('换代时在途的请求在旧的一代里完成', async () => {
  await boot()
  const actor = await env.actor()
  await install(await buildPackage({ id: 'probe', source: probe('1') }), actor)
  await env.core.plugins.admin.enable(actor, 'probe')
  const first = env.core.plugins.hostStatus().generation
  const slow = env.core.plugins.route(route('probe', '/slow'))
  await install(await buildPackage({ id: 'other', source: probe('other') }), actor)
  await env.core.plugins.admin.enable(actor, 'other')
  expect(env.core.plugins.hostStatus()).toMatchObject({ plugins: ['other', 'probe'] })
  expect(env.core.plugins.hostStatus().generation).toBeGreaterThan(first!)
  expect(text((await slow).body)).toBe('slow 1')
})

test('host 崩溃后退避重启；连续崩溃后停止重启，等管理员重启', async () => {
  await boot({ maxCrashes: 2 })
  const actor = await env.actor()
  await install(await buildPackage({ id: 'probe', source: probe('1') }), actor)
  await env.core.plugins.admin.enable(actor, 'probe')
  await env.core.plugins.start()

  await expect(env.core.plugins.route(route('probe', '/crash'))).rejects.toMatchObject({
    code: 'plugin_unavailable',
  })
  expect(env.core.plugins.isRunning('probe')).toBe(false)
  await until(() => env.core.plugins.hostStatus().state === 'running')
  expect(text((await env.core.plugins.route(route('probe', '/version'))).body)).toBe('1')

  await expect(env.core.plugins.route(route('probe', '/crash'))).rejects.toMatchObject({
    code: 'plugin_unavailable',
  })
  expect(env.core.plugins.hostStatus()).toMatchObject({ state: 'failed', lastError: 'code=3 signal=' })
  await env.core.plugins.admin.restartHost(actor)
  expect(env.core.plugins.hostStatus().state).toBe('running')
  expect(text((await env.core.plugins.route(route('probe', '/version'))).body)).toBe('1')
})

const codes = () =>
  env.db
    .withTables<{ p_invitation_codes__codes: { code: string } }>()
    .selectFrom('p_invitation_codes__codes')
    .selectAll()
    .execute()

/** 让卸载的清理任务现在就到期并执行 */
async function runCleanup() {
  await env.db
    .updateTable('jobs')
    .set({ run_at: toIsoTimestamp(new Date(0)) })
    .where('name', '=', PLUGIN_CLEANUP_JOB)
    .execute()
  await env.core.jobs.drain()
}

async function installInvitationCodes(actor: { uid: number; ip: string }) {
  const bytes = await buildPackage({ id: 'invitation-codes', from: 'plugins/invitation-codes' })
  await install(bytes, actor)
  await env.core.plugins.admin.enable(actor, 'invitation-codes')
  return bytes
}

test('卸载：当场删掉设置、任务和插件表的这一行；表、插件包和解开的目录由清理任务稍后删', async () => {
  const storage = await boot()
  const actor = await env.actor()
  await installInvitationCodes(actor)
  await env.core.plugins.admin.updateSettings(actor, 'invitation-codes', { defaultExpiresInDays: 7 })
  await expect(env.core.plugins.admin.uninstall(actor, 'nope')).rejects.toMatchObject({ code: 'plugin_not_found' })

  await env.core.plugins.admin.uninstall(actor, 'invitation-codes')
  expect(env.core.plugins.get('invitation-codes')).toBeUndefined()
  expect(env.core.plugins.hostStatus()).toMatchObject({ state: 'idle', plugins: [] })
  expect(await env.db.selectFrom('plugins').selectAll().execute()).toEqual([])
  expect(
    await env.db.selectFrom('settings').select('key').where('namespace', '=', 'plugin:invitation-codes').execute(),
  ).toEqual([])
  // 旧的一代可能还在做在途的调用：表和插件包先留着，清理任务十几分钟后才执行
  expect(await codes()).toEqual([])
  const [cleanup] = await env.db.selectFrom('jobs').select(['name', 'run_at']).execute()
  expect(cleanup).toMatchObject({ name: PLUGIN_CLEANUP_JOB })
  expect(Date.parse(cleanup!.run_at) - Date.now()).toBeGreaterThan(10 * 60_000)

  // 别的实例在同步之前又给它展开了一个事件任务、补上了定时任务条目：清理时一起删掉
  const now = toIsoTimestamp(new Date())
  await env.db
    .insertInto('jobs')
    .values({ name: 'plugin:invitation-codes:on:user.registered', payload: '{}', run_at: now, created_at: now })
    .execute()
  await env.db
    .insertInto('job_schedules')
    .values({ name: 'plugin:invitation-codes:cron:0', cron: '0 * * * *', time_zone: 'UTC', next_run_at: now })
    .execute()
  await runCleanup()
  await expect(codes()).rejects.toThrow()
  expect(await env.db.selectFrom('jobs').selectAll().execute()).toEqual([])
  expect(await env.db.selectFrom('job_schedules').select('name').where('name', 'like', 'plugin:%').execute()).toEqual(
    [],
  )
  expect(await readdir(join(storage.dir, 'plugin-packages'))).toEqual([])
  expect(await readdir(join(storage.dir, 'plugins'))).toEqual([])
  expect(
    (await env.db.selectFrom('audit_logs').select('action').orderBy('id').execute()).map((row) => row.action),
  ).toEqual(['plugin.install', 'plugin.enable', 'plugin.settings', 'plugin.uninstall'])
})

test('处理卸载的实例取不到这个插件的包：清理照样按物理名的前缀删掉它的表', async () => {
  const storage = await boot()
  const actor = await env.actor()
  await installInvitationCodes(actor)
  // 本实例没有它的 manifest，存储和本地也都取不到包
  vi.spyOn(env.core.plugins, 'get').mockReturnValue(undefined)
  await env.core.plugins.admin.uninstall(actor, 'invitation-codes')
  vi.mocked(env.core.plugins.get).mockRestore()
  await rm(join(storage.dir, 'plugin-packages'), { recursive: true })
  await rm(join(storage.dir, 'plugins'), { recursive: true })
  await runCleanup()
  await expect(codes()).rejects.toThrow()
  expect(await env.db.selectFrom('jobs').selectAll().execute()).toEqual([])
})

test.each([
  ['还在队列里', 'queued'],
  ['连续失败进了死信', 'failed'],
  ['的记录已经没有了（死信过了保留期）', 'gone'],
] as const)('卸载后不久又装回来，上次卸载的清理%s：新装的插件从空状态开始', async (_, record) => {
  await boot()
  const actor = await env.actor()
  const bytes = await installInvitationCodes(actor)
  await env.core.plugins.route({
    ...route('invitation-codes', '/codes', actor),
    method: 'POST',
    request: {
      method: 'POST',
      url: 'https://skin.example.test/plugins/invitation-codes/codes',
      headers: [['content-type', 'application/json']],
      body: new TextEncoder().encode(JSON.stringify({ count: 1 })),
    },
  })
  await env.core.plugins.admin.uninstall(actor, 'invitation-codes')
  const job = await env.db.selectFrom('jobs').selectAll().executeTakeFirstOrThrow()
  if (record !== 'queued') await env.db.deleteFrom('jobs').execute()
  if (record === 'failed')
    await env.db
      .insertInto('failed_jobs')
      .values({
        name: job.name,
        payload: job.payload,
        dedupe_key: job.dedupe_key,
        attempts: 5,
        last_error: 'error',
        created_at: job.created_at,
        failed_at: toIsoTimestamp(new Date()),
      })
      .execute()
  // 卸载之后、清理之前又被写回来的设置（例如另一个实例上没拿锁的旧版本）
  await env.db
    .insertInto('settings')
    .values({
      namespace: 'plugin:invitation-codes',
      key: 'defaultExpiresInDays',
      value: '7',
      updated_at: toIsoTimestamp(new Date()),
    })
    .execute()

  await install(bytes, actor)
  expect(await env.db.selectFrom('jobs').selectAll().execute()).toEqual([])
  expect(await env.db.selectFrom('failed_jobs').selectAll().execute()).toEqual([])
  expect(
    await env.db.selectFrom('settings').select('key').where('namespace', '=', 'plugin:invitation-codes').execute(),
  ).toEqual([])
  await env.core.plugins.admin.enable(actor, 'invitation-codes')
  expect(env.core.plugins.isRunning('invitation-codes')).toBe(true)
  expect(await codes()).toEqual([])
})

test('改设置和卸载串行：拿着这个插件的锁时改设置报忙；本实例还没同步到卸载时，改设置找不到插件，不写回设置', async () => {
  await boot()
  const actor = await env.actor()
  await installInvitationCodes(actor)
  await env.core.plugins.withLock('invitation-codes', async () => {
    await expect(
      env.core.plugins.admin.updateSettings(actor, 'invitation-codes', { defaultExpiresInDays: 7 }),
    ).rejects.toMatchObject({ code: 'plugin_busy' })
  })
  const known = env.core.plugins.get('invitation-codes')
  await env.core.plugins.admin.uninstall(actor, 'invitation-codes')
  // 别的实例上卸载的：本实例最多 5 秒后才同步，这期间插件还在、校验设置也照常通过
  vi.spyOn(env.core.plugins, 'get').mockReturnValue(known)
  vi.spyOn(env.core.plugins, 'validateSettings').mockResolvedValue({ ok: true, fields: [] })
  await expect(
    env.core.plugins.admin.updateSettings(actor, 'invitation-codes', { defaultExpiresInDays: 7 }),
  ).rejects.toMatchObject({ code: 'plugin_not_found' })
  vi.mocked(env.core.plugins.get).mockRestore()
  expect(await env.db.selectFrom('settings').select('key').where('namespace', 'like', 'plugin:%').execute()).toEqual([])
})

test('别的插件依赖这个插件时：不能停用、卸载它，也不能升级到不满足依赖范围的版本', async () => {
  await boot()
  const actor = await env.actor()
  await install(await buildPackage({ id: 'beta', source: probe('b') }), actor)
  await env.core.plugins.admin.enable(actor, 'beta')
  await install(
    await buildPackage({ id: 'alpha', source: probe('a'), nextskin: { requires: { beta: '^1.0.0' } } }),
    actor,
  )
  await env.core.plugins.admin.enable(actor, 'alpha')

  const required = { code: 'plugin_required_by', params: { plugin: 'alpha', range: '^1.0.0' } }
  await expect(env.core.plugins.admin.disable(actor, 'beta')).rejects.toMatchObject(required)
  await expect(env.core.plugins.admin.uninstall(actor, 'beta')).rejects.toMatchObject(required)
  const major = await buildPackage({ id: 'beta', version: '2.0.0', source: probe('b2') })
  await expect(env.core.plugins.admin.preview(actor, major)).rejects.toMatchObject(required)
  // 范围里的版本照常升级
  await install(await buildPackage({ id: 'beta', version: '1.1.0', source: probe('b1') }), actor)
  expect(await env.db.selectFrom('plugins').select('version').where('id', '=', 'beta').execute()).toEqual([
    { version: '1.1.0' },
  ])

  // 先停用依赖它的插件，就都可以了
  await env.core.plugins.admin.disable(actor, 'alpha')
  await env.core.plugins.admin.disable(actor, 'beta')
  await env.core.plugins.admin.uninstall(actor, 'beta')
})

test('本实例从来没取到过包的启用插件：后台列出来，标着取不到插件包；不能启用，能停用、卸载', async () => {
  const storage = await boot()
  const actor = await env.actor()
  await install(await buildPackage({ id: 'probe', source: probe('1') }), actor)
  await env.core.plugins.admin.enable(actor, 'probe')
  // 另一个实例：自己的解包目录，共享的存储里这时却取不到包
  await rm(join(storage.dir, 'plugin-packages'), { recursive: true })
  await env.boot([], {
    plugins: {
      host: hostEntry,
      packages: createPluginPackages({
        directory: join(storage.dir, 'other-instance'),
        store: createLocalPluginPackageStore(join(storage.dir, 'plugin-packages')),
      }),
    },
  })
  expect(env.core.plugins.get('probe')).toBeUndefined()
  expect(await env.core.plugins.admin.list(actor)).toEqual([
    expect.objectContaining({ id: 'probe', version: '1.0.0', enabled: true, running: false, packageMissing: true }),
  ])
  await env.core.plugins.admin.disable(actor, 'probe')
  expect(await env.core.plugins.admin.list(actor)).toEqual([
    expect.objectContaining({ id: 'probe', enabled: false, packageMissing: true }),
  ])
  await expect(env.core.plugins.admin.enable(actor, 'probe')).rejects.toMatchObject({ code: 'plugin_unavailable' })
  await env.core.plugins.admin.uninstall(actor, 'probe')
  expect(await env.core.plugins.admin.list(actor)).toEqual([])
  expect(
    (await env.db.selectFrom('audit_logs').select('action').orderBy('id').execute()).map((row) => row.action),
  ).toEqual(['plugin.install', 'plugin.enable', 'plugin.disable', 'plugin.uninstall'])
})

test('插件自己抛出和"host 不可用"同名的错误：照常算一次失败，任务不会被无限推迟', async () => {
  await boot()
  const actor = await env.actor()
  const source = `
import { definePlugin } from '@nextskin/plugin-sdk'
export default definePlugin({
  capabilities: [],
  jobs: {
    spoof: {
      maxAttempts: 1,
      handler: async () => {
        throw Object.assign(new Error('not really'), { name: 'PluginHostUnavailableError' })
      },
    },
  },
  routes: {
    'POST /enqueue': {
      auth: 'public',
      handler: async ({ ctx }) => {
        await ctx.jobs.enqueue('spoof', {})
        return new Response('queued')
      },
    },
  },
})
`
  await install(await buildPackage({ id: 'probe', source }), actor)
  await env.core.plugins.admin.enable(actor, 'probe')
  await env.core.plugins.route({ ...route('probe', '/enqueue'), method: 'POST' })
  await env.core.jobs.drain()
  expect(await env.db.selectFrom('jobs').selectAll().execute()).toEqual([])
  expect(await env.db.selectFrom('failed_jobs').select(['name', 'attempts']).execute()).toEqual([
    { name: 'plugin:probe:job:spoof', attempts: 1 },
  ])
})

test('同一个插件的管理操作在各实例之间串行：别的实例拿着它的锁时启用、升级、卸载都报忙，清理任务推迟', async () => {
  await boot()
  const actor = await env.actor()
  await install(await buildPackage({ id: 'probe', source: probe('1') }), actor)
  const upgrade = await buildPackage({ id: 'probe', version: '1.1.0', source: probe('2') })
  const { packageHash } = await env.core.plugins.admin.preview(actor, upgrade)
  await env.core.plugins.withLock('probe', async () => {
    await expect(env.core.plugins.admin.enable(actor, 'probe')).rejects.toMatchObject({ code: 'plugin_busy' })
    await expect(env.core.plugins.admin.install(actor, upgrade, packageHash)).rejects.toMatchObject({
      code: 'plugin_busy',
    })
    await expect(env.core.plugins.admin.uninstall(actor, 'probe')).rejects.toMatchObject({ code: 'plugin_busy' })
  })
  expect(await env.db.selectFrom('plugins').select(['version', 'is_enabled']).execute()).toEqual([
    { version: '1.0.0', is_enabled: 0 },
  ])

  await env.core.plugins.admin.uninstall(actor, 'probe')
  // 清理任务到期时别的实例正在操作这个插件（例如正在装回来）：推迟，不算一次尝试
  await env.core.plugins.withLock('probe', () => runCleanup())
  const [deferred] = await env.db.selectFrom('jobs').select(['name', 'attempts', 'run_at']).execute()
  expect(deferred).toMatchObject({ name: PLUGIN_CLEANUP_JOB, attempts: 0 })
  expect(Date.parse(deferred!.run_at)).toBeGreaterThan(Date.now())
  await runCleanup()
  expect(await env.db.selectFrom('jobs').selectAll().execute()).toEqual([])
})

test('表里换成了本实例取不到的新版本：不再用旧版本的 manifest 和代码，按不可用处理，注册按失败策略关闭', async () => {
  await boot()
  const actor = await env.actor()
  await install(await buildPackage({ id: 'probe', source: probe('1') }), actor)
  await env.core.plugins.admin.enable(actor, 'probe')
  // 1.0.0 不拦截注册
  await env.core.users.register(env.input())

  // 别的实例升级到了 1.1.0，本实例取不到它的包：新版本拦不拦截注册不知道
  await env.db
    .updateTable('plugins')
    .set({ version: '1.1.0', package_hash: 'f'.repeat(64) })
    .where('id', '=', 'probe')
    .execute()
  await env.core.plugins.sync()
  expect(env.core.plugins.isActive('probe')).toBe(false)
  expect(env.core.plugins.hostStatus().plugins).toEqual([])
  await expect(env.core.users.register(env.input())).rejects.toMatchObject({ code: 'plugin_unavailable' })
  expect(() => env.core.plugins.routeOf('probe', 'GET', '/version')).toThrow(
    expect.objectContaining({ code: 'plugin_unavailable' }),
  )
  await expect(env.core.plugins.route(route('probe', '/version'))).rejects.toMatchObject({
    code: 'plugin_unavailable',
  })
})

test('host 不可用时事件和任务留在队列里：入队照常，执行到一半 host 退出的不算一次尝试，也不进死信', async () => {
  await boot({ maxCrashes: 1 })
  const actor = await env.actor()
  const source = `
import { definePlugin } from '@nextskin/plugin-sdk'
export default definePlugin({
  capabilities: [],
  jobs: { crash: { maxAttempts: 1, handler: async () => { process.exit(3) } } },
  on: { 'user.registered': async () => {} },
  routes: {
    'POST /enqueue': {
      auth: 'public',
      handler: async ({ ctx }) => {
        await ctx.jobs.enqueue('crash', {})
        return new Response('queued')
      },
    },
  },
})
`
  await install(await buildPackage({ id: 'probe', source }), actor)
  await env.core.plugins.admin.enable(actor, 'probe')
  await env.core.plugins.route({ ...route('probe', '/enqueue'), method: 'POST' })
  await env.core.jobs.drain()
  expect(env.core.plugins.hostStatus().state).toBe('failed')
  expect(await env.db.selectFrom('jobs').select(['name', 'attempts']).execute()).toEqual([
    { name: 'plugin:probe:job:crash', attempts: 0 },
  ])
  expect(await env.db.selectFrom('failed_jobs').selectAll().execute()).toEqual([])

  // host 停着：发出事件的业务事务照常提交，插件的事件任务排着队、暂不认领
  const { uid } = await env.core.users.register(env.input())
  await env.core.jobs.drain()
  expect((await env.db.selectFrom('jobs').select('name').orderBy('id').execute()).map((row) => row.name)).toEqual([
    'plugin:probe:job:crash',
    'plugin:probe:on:user.registered',
  ])
  expect(uid).toBeGreaterThan(0)

  await env.db.deleteFrom('jobs').where('name', '=', 'plugin:probe:job:crash').execute()
  await env.core.plugins.admin.restartHost(actor)
  await env.core.jobs.drain()
  expect(await env.db.selectFrom('jobs').selectAll().execute()).toEqual([])
})

test('新实例取不到插件包：拦截注册的插件按失败策略关闭注册，它的路由返回不可用', async () => {
  const storage = await boot()
  const actor = await env.actor()
  await install(await buildPackage({ id: 'invitation-codes', from: 'plugins/invitation-codes' }), actor)
  await env.core.plugins.admin.enable(actor, 'invitation-codes')
  // 另一个实例：自己的解包目录，共享的存储里这时却取不到包
  await rm(join(storage.dir, 'plugin-packages'), { recursive: true })
  await env.boot([], {
    plugins: {
      host: hostEntry,
      packages: createPluginPackages({
        directory: join(storage.dir, 'other-instance'),
        store: createLocalPluginPackageStore(join(storage.dir, 'plugin-packages')),
      }),
    },
  })
  await expect(env.core.users.register(env.input())).rejects.toMatchObject({ code: 'plugin_unavailable' })
  await expect(env.core.plugins.route(route('invitation-codes', '/codes', actor))).rejects.toMatchObject({
    code: 'plugin_unavailable',
  })
})

test('同一个版本号、内容不同的两个包解到不同的目录，先解开的不会被换掉', async () => {
  const { packages } = await pluginPackages()
  const first = await packages.add(await buildPackage({ id: 'probe', source: probe('1') }))
  const second = await packages.add(await buildPackage({ id: 'probe', source: probe('X') }))
  expect(first.version).toBe(second.version)
  expect(first.dir).not.toBe(second.dir)
  expect(await readFile(join(first.dir, 'server.mjs'), 'utf8')).toContain('slow 1')
  expect(await readFile(join(second.dir, 'server.mjs'), 'utf8')).toContain('slow X')
})

test('别的进程刚解开的包目录不清理：按标记文件的修改时间判断，安装又用到它时重新计时（ADR-0049）', async () => {
  const { dir } = await pluginPackages()
  const shared = {
    directory: join(dir, 'plugins'),
    store: createLocalPluginPackageStore(join(dir, 'plugin-packages')),
  }
  // 两个进程（命令行和服务）各自的实例，用同一个数据目录
  const cli = createPluginPackages(shared)
  const service = createPluginPackages(shared)
  const bytes = await buildPackage({ id: 'probe', source: probe('1') })
  const local = await cli.add(bytes)
  const marker = join(local.dir, '.package-sha256')
  const age = async (minutes: number) => {
    const at = new Date(Date.now() - minutes * 60_000)
    await utimes(marker, at, at)
  }
  await service.prune(new Set())
  expect(await readdir(local.dir)).toContain('server.mjs')

  await age(11)
  await cli.add(bytes)
  await service.prune(new Set())
  expect(await readdir(local.dir)).toContain('server.mjs')

  await age(11)
  await service.prune(new Set())
  await expect(readdir(local.dir)).rejects.toMatchObject({ code: 'ENOENT' })

  // 清理先把目录挪开再删；挪开之后进程退出了，下次清理时删掉。刚被用上、没来得及挪回的过了新鲜期再删
  const leftover = join(dir, 'plugins', 'probe', `.${local.hash}.leftover.trash`)
  await mkdir(leftover, { recursive: true })
  await writeFile(join(leftover, '.package-sha256'), local.hash)
  await service.prune(new Set())
  expect(await readdir(join(dir, 'plugins', 'probe'))).toEqual([`.${local.hash}.leftover.trash`])
  const at = new Date(Date.now() - 11 * 60_000)
  await utimes(join(leftover, '.package-sha256'), at, at)
  await service.prune(new Set())
  expect(await readdir(join(dir, 'plugins'))).toEqual([])
})

/** 一段带迁移的探针插件：路由报告版本，迁移建一张表、写一行 */
const staged = (version: string) => `
import { definePlugin, table } from '@nextskin/plugin-sdk'

export default definePlugin({
  capabilities: ['storage.tables'],
  tables: { notes: table() },
  migrations: {
    '001': {
      up: async (db) => {
        await db.schema.createTable('notes').addColumn('value', 'varchar(64)').execute()
      },
    },
    ${version === '1' ? '' : `'002': { up: async (db) => { await db.insertInto('notes').values({ value: '${version}' }).execute() } },`}
  },
  routes: {
    'GET /version': { auth: 'public', handler: async () => new Response('${version}') },
  },
  providers: {
    login: [{ id: 'main', label: 'login.main', icon: 'github',
      authorizeUrl: () => Promise.resolve('https://identity.example.test/authorize'),
      exchange: async () => ({ subject: 'subject', email: null, emailVerified: false, displayName: null }) }],
  },
})
`

test('命令行（host 只用来准备）安装、启用、升级、停用、卸载上传的插件：自己不运行插件，运行中的服务同步之后接上（ADR-0049）', async () => {
  const storage = await boot()
  const actor = await env.actor()
  // 命令行是另一个进程：自己的核心，同一个库、同一个数据目录（插件目录和包存储），host 只用来准备
  const cli = createCore({
    db: env.db,
    secretKey: env.secretKey,
    production: false,
    textureStorage: {
      list: () => Promise.resolve([]),
      listTemp: () => Promise.resolve([]),
      lateDeleteWindowMs: 0,
      write: async () => {},
      delete: async () => {},
      deleteTemp: async () => {},
      read: () => Promise.resolve(null),
    },
    plugins: {
      sqliteFile: env.databaseFile,
      logger: env.logger,
      host: hostEntry,
      hostMode: 'stage',
      // 同步只在测试里手动触发
      syncIntervalMs: 3_600_000,
      packages: createPluginPackages({
        directory: join(storage.dir, 'plugins'),
        store: createLocalPluginPackageStore(join(storage.dir, 'plugin-packages')),
      }),
    },
    jobs: { logger: env.logger },
  })
  await cli.plugins.start()
  try {
    const admin = cli.plugins.admin
    const first = await buildPackage({ id: 'staged', source: staged('1') })
    const second = await buildPackage({ id: 'staged', version: '1.1.0', source: staged('2') })
    const preview = await admin.previewAsSystem(first)
    expect(preview).toMatchObject({ action: 'install', previous: null, installedPackageHash: null })
    const stale = await admin.previewAsSystem(second)
    expect(await admin.installAsSystem(first, preview)).toEqual({
      id: 'staged',
      version: '1.0.0',
      action: 'install',
    })
    // 预览之后插件被装上了：要不要确认是按预览决定的，不再作数
    await expect(admin.installAsSystem(second, stale)).rejects.toMatchObject({ code: 'plugin_busy' })
    await env.core.plugins.sync()
    expect(await env.core.plugins.admin.list(actor)).toEqual([
      expect.objectContaining({ id: 'staged', enabled: false, packageMissing: false }),
    ])

    // 启用：迁移在命令行临时拉起的一代里跑完，那一代随后就杀掉；命令行自己不运行它
    expect(await admin.enableAsSystem('staged')).toEqual({ changed: true })
    expect(await admin.enableAsSystem('staged')).toEqual({ changed: false })
    expect(cli.plugins.hostStatus()).toMatchObject({ enabled: false, state: 'disabled', plugins: [] })
    expect(cli.plugins.isRunning('staged')).toBe(false)
    expect(
      await env.db.selectFrom('plugin_migrations').select('name').where('plugin_id', '=', 'staged').execute(),
    ).toEqual([{ name: '001' }])
    expect(env.core.plugins.isRunning('staged')).toBe(false)
    await env.core.plugins.sync()
    expect(env.core.plugins.isRunning('staged')).toBe(true)
    expect(text((await env.core.plugins.route(route('staged', '/version'))).body)).toBe('1')
    // 命令行算卸载确认里的用户数时，按服务上的登录按钮算：插件在服务上运行，命令行里没有运行
    expect(await cli.plugins.loginProviders()).toEqual(await env.core.plugins.loginProviders())
    expect(await cli.plugins.loginProviders()).toEqual([expect.objectContaining({ pluginId: 'staged' })])

    // 升级启用中的插件：新版本的迁移同样在命令行里跑；服务同步之前照旧是旧版本
    const upgrade = await admin.previewAsSystem(second)
    expect(upgrade).toMatchObject({
      action: 'upgrade',
      previous: { version: '1.0.0', enabled: true, addedCapabilities: [] },
      comparedWithInstalled: true,
    })
    await admin.installAsSystem(second, upgrade)
    const notes = env.db.withTables<{ p_staged__notes: { value: string } }>()
    expect(await notes.selectFrom('p_staged__notes').select('value').execute()).toEqual([{ value: '2' }])
    expect(text((await env.core.plugins.route(route('staged', '/version'))).body)).toBe('1')
    await env.core.plugins.sync()
    expect(text((await env.core.plugins.route(route('staged', '/version'))).body)).toBe('2')

    // 别的进程刚升级、命令行还没同步：比较用的不是装着的包，比出来的"新增"不可信
    const third = await buildPackage({ id: 'staged', version: '1.2.0', source: staged('2') })
    const fourth = await buildPackage({ id: 'staged', version: '1.3.0', source: staged('2') })
    await env.core.plugins.admin.install(actor, third, (await env.core.plugins.admin.preview(actor, third)).packageHash)
    expect(await admin.previewAsSystem(fourth)).toMatchObject({
      previous: { version: '1.2.0' },
      comparedWithInstalled: false,
    })
    await cli.plugins.sync()
    expect(await admin.previewAsSystem(fourth)).toMatchObject({ comparedWithInstalled: true })

    expect(await admin.disableAsSystem('staged')).toEqual({ changed: true })
    await env.core.plugins.sync()
    expect(env.core.plugins.isRunning('staged')).toBe(false)

    await admin.uninstallAsSystem('staged')
    await env.core.plugins.sync()
    expect(env.core.plugins.get('staged')).toBeUndefined()
    expect(await env.db.selectFrom('jobs').select('name').execute()).toEqual([{ name: PLUGIN_CLEANUP_JOB }])
    expect(
      await env.db
        .selectFrom('audit_logs')
        .select(['action', 'actor_type', 'actor_user_id', 'ip'])
        .where('actor_type', '!=', 'user')
        .orderBy('id')
        .execute(),
    ).toEqual(
      ['plugin.install', 'plugin.enable', 'plugin.upgrade', 'plugin.disable', 'plugin.uninstall'].map((action) => ({
        action,
        actor_type: 'system',
        actor_user_id: null,
        ip: null,
      })),
    )
  } finally {
    await cli.shutdown()
  }
})

test('预览之后这个插件被别人改过：安装按冲突处理，不改表', async () => {
  const storage = await boot()
  const actor = await env.actor()
  await install(await buildPackage({ id: 'probe', source: probe('1') }), actor)
  const upgrade = await buildPackage({ id: 'probe', version: '1.1.0', source: probe('2') })
  const { packageHash } = await env.core.plugins.admin.preview(actor, upgrade)
  // 解包的这段时间里，另一个实例上的管理员启用了它：升级要不要先准备新一代，是按预览时的状态决定的
  const add = storage.packages.add.bind(storage.packages)
  vi.spyOn(storage.packages, 'add').mockImplementationOnce(async (bytes) => {
    await env.db.updateTable('plugins').set({ is_enabled: 1 }).where('id', '=', 'probe').execute()
    return add(bytes)
  })
  await expect(env.core.plugins.admin.install(actor, upgrade, packageHash)).rejects.toMatchObject({
    code: 'plugin_busy',
  })
  expect(await env.db.selectFrom('plugins').select(['version']).execute()).toEqual([{ version: '1.0.0' }])
})

test('互相冲突的两个插件同时启用：只有一个能启用', async () => {
  await boot()
  const actor = await env.actor()
  await install(await buildPackage({ id: 'alpha', source: probe('a'), nextskin: { conflicts: ['beta'] } }), actor)
  await install(await buildPackage({ id: 'beta', source: probe('b') }), actor)
  const results = await Promise.allSettled([
    env.core.plugins.admin.enable(actor, 'alpha'),
    env.core.plugins.admin.enable(actor, 'beta'),
  ])
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.find((result) => result.status === 'rejected')).toMatchObject({
    reason: { code: 'plugin_conflict' },
  })
  expect(await env.db.selectFrom('plugins').select('id').where('is_enabled', '=', 1).execute()).toHaveLength(1)
})

test('判断冲突时对方在本实例上的 manifest 过时了（别的实例刚升级它）：不按旧的判断，报忙', async () => {
  await boot()
  const actor = await env.actor()
  await install(await buildPackage({ id: 'alpha', source: probe('a') }), actor)
  await env.core.plugins.admin.enable(actor, 'alpha')
  await install(await buildPackage({ id: 'beta', source: probe('b') }), actor)
  // 新版本的 alpha 可能声明了和 beta 冲突
  await env.db
    .updateTable('plugins')
    .set({ version: '1.1.0', package_hash: 'f'.repeat(64) })
    .where('id', '=', 'alpha')
    .execute()
  await expect(env.core.plugins.admin.enable(actor, 'beta')).rejects.toMatchObject({ code: 'plugin_busy' })
})

test('调度器不认的 cron 在安装前就被拒绝', async () => {
  await boot()
  const actor = await env.actor()
  const source = `
import { definePlugin } from '@nextskin/plugin-sdk'
export default definePlugin({
  capabilities: [],
  jobs: { tick: { handler: async () => {} } },
  cron: [{ schedule: '99 * * * *', job: 'tick' }],
})
`
  await expect(
    env.core.plugins.admin.preview(actor, await buildPackage({ id: 'probe', source })),
  ).rejects.toMatchObject({ code: 'plugin_package_invalid', params: { reason: 'invalid_cron' } })
})

test('准备好的新一代在改表期间退出了：不切换到死掉的一代，按常规重新拉起', async () => {
  const storage = await boot()
  const actor = await env.actor()
  await install(await buildPackage({ id: 'probe', source: probe('1') }), actor)
  await env.core.plugins.admin.enable(actor, 'probe')
  // 新版本的迁移让它所在的那一代过一会儿退出：迁移本身成功了
  const exiting = probe('2', "'storage.tables'").replace(
    '  routes: {',
    `  migrations: { '0001_exit': { async up() { setTimeout(() => process.exit(3), 100) } } },
  routes: {`,
  )
  const local = await storage.packages.add(await buildPackage({ id: 'probe', version: '1.1.0', source: exiting }))
  await env.core.plugins.stage(local, async (staged) => {
    await staged.migrate(() => toIsoTimestamp(new Date()))
    await new Promise((resolve) => setTimeout(resolve, 500))
    await env.db
      .updateTable('plugins')
      .set({ version: local.version, package_hash: local.hash })
      .where('id', '=', 'probe')
      .execute()
  })
  expect(env.core.plugins.hostStatus()).toMatchObject({ state: 'running' })
  expect(text((await env.core.plugins.route(route('probe', '/version'))).body)).toBe('2')
})

test('官方插件的 id 不能被安装插件占用', async () => {
  await env.boot([official('probe', definePlugin({ capabilities: [] }))], {
    plugins: { host: hostEntry, packages: (await pluginPackages()).packages },
  })
  const actor = await env.actor()
  const bytes = await buildPackage({ id: 'probe', source: probe('1') })
  await expect(env.core.plugins.admin.preview(actor, bytes)).rejects.toMatchObject({ code: 'plugin_id_reserved' })
  await expect(env.core.plugins.admin.uninstall(actor, 'probe')).rejects.toMatchObject({ code: 'plugin_official' })
})

/** 路由 /wait 停在一个出站请求上，测试控制它什么时候返回；/limit 按 ip 限流 */
const waiter = (limit: number) => `import { definePlugin } from '@nextskin/plugin-sdk'
  export default definePlugin({ capabilities: [], network: ['https://example.test'], routes: {
    'GET /wait': { auth: 'public', handler: async ({ ctx }) => {
      ctx.signal.addEventListener('abort', () => process.stderr.write('WAIT_ABORTED\\n'), { once: true })
      return await ctx.fetch('https://example.test/wait')
    } },
    'GET /limit': { auth: 'public', rateLimit: { limit: ${limit}, windowSec: 60, by: 'ip' }, handler: () => Promise.resolve(new Response('ok')) },
  } })`

test('升级保留在途调用；停用取消退役一代里本插件的调用，出站请求也中止', async () => {
  let entered = Promise.withResolvers<void>()
  let outgoing = Promise.withResolvers<Response>()
  let signal: AbortSignal | undefined
  await boot({
    fetch: async (_url, init) => {
      signal = init?.signal ?? undefined
      entered.resolve()
      signal?.addEventListener('abort', () => outgoing.reject(new Error('aborted')), { once: true })
      return outgoing.promise
    },
  })
  const first = await buildPackage({ id: 'waiter', source: waiter(1) })
  const upgraded = await buildPackage({ id: 'waiter', version: '1.1.0', source: waiter(2) })
  const other = await buildPackage({ id: 'other', source: probe('other') })
  const actor = await env.actor()
  await install(first, actor)
  await env.core.plugins.admin.enable(actor, 'waiter')
  await env.core.plugins.route(route('waiter', '/limit'))
  await expect(env.core.plugins.route(route('waiter', '/limit'))).rejects.toMatchObject({ code: 'too_many_requests' })
  const pending = env.core.plugins.route(route('waiter', '/wait'))
  await entered.promise
  await install(upgraded, actor)
  expect(signal?.aborted).toBe(false)
  outgoing.resolve(new Response('old call completed'))
  expect(text((await pending).body)).toBe('old call completed')
  await env.core.plugins.route(route('waiter', '/limit'))
  await env.core.plugins.route(route('waiter', '/limit'))
  await expect(env.core.plugins.route(route('waiter', '/limit'))).rejects.toMatchObject({ code: 'too_many_requests' })

  entered = Promise.withResolvers<void>()
  outgoing = Promise.withResolvers<Response>()
  const cancelled = env.core.plugins.route(route('waiter', '/wait'))
  // 先订阅拒绝，停用可能在管理操作返回之前结算调用。
  const rejected = expect(cancelled).rejects.toMatchObject({ code: 'plugin_timeout' })
  await entered.promise
  await install(other, actor)
  await env.core.plugins.admin.enable(actor, 'other')
  expect(signal?.aborted).toBe(false)
  await env.core.plugins.admin.disable(actor, 'waiter')
  expect(signal?.aborted).toBe(true)
  await rejected
  await until(() =>
    env.records.some(
      (record) => record.source === 'plugin-host' && record.level === 'warn' && record.msg.includes('WAIT_ABORTED'),
    ),
  )
  const stderr = env.records.find((record) => record.msg.includes('WAIT_ABORTED'))!
  expect(stderr).toMatchObject({ source: 'plugin-host', level: 'warn', generation: expect.any(Number) as unknown })
  expect(stderr).not.toHaveProperty('area')
  expect(text((await env.core.plugins.route(route('other', '/version'))).body)).toBe('other')
})

test('调用方给了更短的期限（首页的挂件，ADR-0059）：按它超时，插件的调用也中止', async () => {
  await boot({
    fetch: (_url, init) =>
      new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      ),
  })
  const actor = await env.actor()
  await install(await buildPackage({ id: 'waiter', source: waiter(1) }), actor)
  await env.core.plugins.admin.enable(actor, 'waiter')
  const started = Date.now()
  await expect(env.core.plugins.route({ ...route('waiter', '/wait'), timeoutMs: 200 })).rejects.toMatchObject({
    code: 'plugin_timeout',
  })
  expect(Date.now() - started).toBeLessThan(5_000)
  await until(() =>
    env.records.some(
      (record) => record.source === 'plugin-host' && record.level === 'warn' && record.msg.includes('WAIT_ABORTED'),
    ),
  )
})

test('表里换成了本实例取不到的新版本：插件不可用，但在途的调用照常做完，不中止', async () => {
  const entered = Promise.withResolvers<void>()
  const outgoing = Promise.withResolvers<Response>()
  let signal: AbortSignal | undefined
  await boot({
    fetch: (_url, init) => {
      signal = init?.signal ?? undefined
      entered.resolve()
      return outgoing.promise
    },
  })
  const actor = await env.actor()
  await install(await buildPackage({ id: 'waiter', source: waiter(1) }), actor)
  await env.core.plugins.admin.enable(actor, 'waiter')
  const pending = env.core.plugins.route(route('waiter', '/wait'))
  await entered.promise
  // 别的实例升级了它，本实例暂时取不到新版本的包：这是换代，不是停用
  await env.db
    .updateTable('plugins')
    .set({ version: '1.1.0', package_hash: 'f'.repeat(64) })
    .where('id', '=', 'waiter')
    .execute()
  await env.core.plugins.sync()
  expect(env.core.plugins.isActive('waiter')).toBe(false)
  expect(signal?.aborted).toBe(false)
  outgoing.resolve(new Response('old call completed'))
  expect(text((await pending).body)).toBe('old call completed')
})

test('notifications.send 在 plugin host 里发送、重放和卸载后保留永久键', async () => {
  await boot()
  const actor = await env.actor()
  const bytes = await buildPackage({
    id: 'notice',
    locales: { en: { notice: { title: 'Hello {name}', body: 'Welcome' } } },
    source: `
      import { definePlugin } from '@nextskin/plugin-sdk'
      export default definePlugin({
        capabilities: ['notifications.send'],
        routes: { 'GET /send': { auth: 'public', async handler({ ctx, request }) {
          const uid = Number(new URL(request.url).searchParams.get('uid'))
          return Response.json(await ctx.notifications.send(uid, {
            title: 'notice.title', body: 'notice.body', params: { name: 'Alex' }, link: '/user',
          }, { key: 'once' }))
        } } },
      })
    `,
  })
  const preview = await install(bytes, actor)
  expect(preview.highRisk).toContain('notifications.send')
  await env.core.plugins.admin.enable(actor, 'notice')
  const send = () => env.core.plugins.route(route('notice', `/send?uid=${actor.uid}`))
  expect(text((await send()).body)).toBe('{"status":"sent"}')
  expect(text((await send()).body)).toBe('{"status":"duplicate"}')
  expect(
    await env.db.selectFrom('notifications').selectAll().where('plugin_id', '=', 'notice').execute(),
  ).toMatchObject([
    {
      user_id: actor.uid,
      type: 'plugin',
      title_key: 'notice.title',
      body_key: 'notice.body',
      params: '{"name":"Alex"}',
      link: '/user',
    },
  ])
  await env.core.plugins.admin.uninstall(actor, 'notice')
  await runCleanup()
  expect(await env.db.selectFrom('notifications').select('id').where('plugin_id', '=', 'notice').execute()).toEqual([])
  expect(
    await env.db
      .selectFrom('plugin_notification_keys')
      .select('plugin_key')
      .where('plugin_id', '=', 'notice')
      .execute(),
  ).toEqual([{ plugin_key: 'once' }])
  await install(bytes, actor)
  await env.core.plugins.admin.enable(actor, 'notice')
  expect(text((await send()).body)).toBe('{"status":"duplicate"}')
  expect(await env.db.selectFrom('notifications').select('id').where('plugin_id', '=', 'notice').execute()).toEqual([])
})
