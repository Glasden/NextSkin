import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createTcpServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { coreMigrations } from '@nextskin/db'
import { removeTestDirectory } from '@nextskin/db/testing'
import { HostStartError } from '@nextskin/domain'
import { afterEach, expect, test, vi } from 'vitest'
import type { LauncherContext } from '../context.ts'
import { acquireDataLock } from '../lock.ts'
import {
  checkConfig,
  checkDataDirectory,
  checkDatabase,
  checkEnvFile,
  checkPluginHost,
  checkRelease,
  checkSecret,
  checkService,
  run,
} from './doctor.ts'

const directories: string[] = []
const secret = 'doctor-test-secret-must-never-appear-in-output'
const probeHost = vi.fn(async () => {})
afterEach(async () => {
  vi.restoreAllMocks()
  probeHost.mockClear()
  for (const path of directories.splice(0)) await removeTestDirectory(path)
})
async function context(): Promise<LauncherContext> {
  const root = await mkdtemp(join(tmpdir(), 'launcher-doctor-'))
  directories.push(root)
  // 发行完整性照常检查；只有真实握手由假的探测替代。
  for (const file of ['server/packages/plugin-host/dist/host.mjs', 'server/apps/web/server.js']) {
    await mkdir(join(root, file, '..'), { recursive: true })
    await writeFile(join(root, file), '')
  }
  await writeFile(join(root, 'server/VERSION'), '0.0.0\n')
  return { root, cwd: join(root, 'elsewhere'), source: false, production: true, version: '0.0.0' }
}
async function diagnose(ctx: LauncherContext, env: NodeJS.ProcessEnv = {}) {
  const lines: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((line: string) => lines.push(line))
  try {
    const code = await run([], ctx, { env, probeHost })
    return { code, output: lines.join('\n'), lines }
  } finally {
    log.mockRestore()
  }
}

test('发行模式没有 .env 和密钥时都警告，退出 0，不创建配置、数据目录或数据库', async () => {
  const ctx = await context()
  const before = await readdir(ctx.root)
  const checked = await diagnose(ctx)
  expect(checked.code).toBe(0)
  expect(checked.lines).toContain(`[警告] 配置文件：${join(ctx.root, '.env')}；还没有 .env，第一次 start 时生成`)
  expect(checked.lines).toContain('[警告] 密钥：还没有密钥，第一次 start 时生成')
  expect(checked.output).toContain('还不存在，start 时创建')
  expect(checked.output).toContain('还没有数据库文件，第一次 start 时创建')
  expect(await readdir(ctx.root)).toEqual(before)
  expect(probeHost).toHaveBeenCalledOnce()
  expect(checked.lines).toContain('[通过] 发行目录：0.0.0')
  expect(checked.output.indexOf('发行目录：')).toBeLessThan(checked.output.indexOf('plugin host：'))
})

test.each(['different', 'missing'] as const)('发行目录版本标记 %s 时失败', async (state) => {
  const ctx = await context()
  const file = join(ctx.root, 'server/VERSION')
  if (state === 'missing') await rm(file)
  else await writeFile(file, '9.9.9\n')
  const checked = await diagnose(ctx)
  expect(checked.code).toBe(1)
  expect(checked.output).toContain('[失败] 发行目录：程序版本 0.0.0，server/ ')
  expect(checked.output).toContain(state === 'missing' ? '缺少版本标记' : '版本 9.9.9')
  expect(checked.output).toContain('请停掉服务、删掉 server/ 和 cli/、重新解压完整的发行包')
})

test('发行目录缺少 server.js 时失败，源码模式无需版本标记或 server.js', async () => {
  const ctx = await context()
  await rm(join(ctx.root, 'server/apps/web/server.js'))
  const checked = await checkRelease(ctx)
  expect(checked.status).toBe('fail')
  expect(checked.message).toContain('缺少 server/')
  await rm(join(ctx.root, 'server/VERSION'))
  expect(await checkRelease({ ...ctx, source: true })).toEqual({
    item: '发行目录',
    status: 'pass',
    message: '源码模式',
  })
})

test('已有 .env 但没密钥时失败，保留文件', async () => {
  const ctx = await context()
  const file = join(ctx.root, '.env')
  await writeFile(file, '# keep\nPORT=3000\n', { mode: 0o600 })
  const checked = await diagnose(ctx)
  expect(checked.code).toBe(1)
  expect(checked.output).toContain('[失败] 密钥：生产环境缺少 NEXTSKIN_SECRET')
  expect(await readFile(file, 'utf8')).toBe('# keep\nPORT=3000\n')
})

test.skipIf(process.platform === 'win32')('0644 的 .env 另起一行警告', async () => {
  const ctx = await context()
  const file = join(ctx.root, '.env')
  await writeFile(file, `NEXTSKIN_SECRET=${secret}\n`)
  await chmod(file, 0o644)
  const checked = await diagnose(ctx)
  expect(checked.code).toBe(0)
  expect(checked.lines).toContain(`[警告] 配置文件权限：同组或其他人可读，建议 chmod 600 ${file}`)
  expect(checked.output).not.toContain(secret)
})

test('短密钥失败；环境优先，合并不修改原环境，说明密钥来源', async () => {
  const ctx = await context()
  await writeFile(join(ctx.root, 'custom.env'), 'NEXTSKIN_SECRET=short\nPORT=5000\n', { mode: 0o600 })
  const env = { NEXTSKIN_ENV_FILE: 'custom.env' }
  const checked = await diagnose(ctx, env)
  expect(checked.code).toBe(1)
  expect(checked.output).toContain('[失败] 密钥：来源：.env；NEXTSKIN_SECRET 至少要有 32 个字符')
  expect(env).toEqual({ NEXTSKIN_ENV_FILE: 'custom.env' })
  const overridden = await diagnose(ctx, { ...env, NEXTSKIN_SECRET: secret })
  expect(overridden.code).toBe(0)
  expect(overridden.output).toContain('[通过] 密钥：来源：环境变量；长度符合要求')
  expect(overridden.output).not.toContain(secret)
})

test('源码模式开发密钥通过，合并 NODE_ENV 后生产环境缺密钥失败', async () => {
  const ctx = { ...(await context()), source: true, production: false }
  const missing = await checkEnvFile(ctx, {})
  expect(missing.results[0]?.status).toBe('pass')
  expect(checkSecret(ctx, {}, {}, false)).toMatchObject({ status: 'pass', message: '来源：源码模式的开发密钥' })
  await writeFile(join(ctx.root, '.env'), 'NODE_ENV=production\n', { mode: 0o600 })
  const production = await checkEnvFile(ctx, {})
  expect(checkSecret(ctx, production.env, {}, false).status).toBe('fail')
})

test('配置文件读不了、配置格式或端口有错时失败，依赖配置的检查跳过', async () => {
  const ctx = await context()
  for (const env of [
    { NEXTSKIN_ENV_FILE: '.' },
    { NEXTSKIN_DATABASE_URL: 'bad://user:private@db/site' },
    { NEXTSKIN_PORT: '0' },
  ]) {
    const checked = await diagnose(ctx, { NEXTSKIN_SECRET: secret, ...env })
    expect(checked.code).toBe(1)
    for (const item of ['数据目录', '数据库', '服务'])
      expect(checked.lines).toContain(`[跳过] ${item}：配置有错，没有检查`)
    // 配置文件读不了只算一项失败，依赖它的检查是跳过
    if (env.NEXTSKIN_ENV_FILE) expect(checked.output).toMatch(/项警告，1 项失败$/)
    expect(checked.output).not.toContain('private')
  }
  expect(checkConfig(ctx, { NEXTSKIN_PORT: '4000', PORT: '5000', NEXTSKIN_HOST: '::' })).toMatchObject({
    host: '::',
    port: 4000,
  })
})

test('SQLite 文件不存在时通过且不创建；空库没有迁移表时通过', async () => {
  const ctx = await context()
  const file = join(ctx.root, 'absent.sqlite')
  const missing = await checkDatabase({ dialect: 'sqlite', file })
  expect(missing.status).toBe('pass')
  expect(missing.message).toContain('还没有数据库文件')
  await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  new DatabaseSync(file).close()
  const empty = await checkDatabase({ dialect: 'sqlite', file })
  expect(empty.status).toBe('pass')
  expect(empty.message).toContain('空库，还没执行过迁移')
})

test.each(['all', 'pending', 'newer'] as const)('SQLite 只读检查迁移状态：%s', async (state) => {
  const ctx = await context()
  const file = join(ctx.root, 'site.sqlite')
  const names = Object.keys(coreMigrations)
  if (state === 'pending') names.pop()
  if (state === 'newer') names.push('9998_newer', '9999_newest')
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE nextskin_migration (name TEXT PRIMARY KEY)')
  for (const name of names) db.prepare('INSERT INTO nextskin_migration (name) VALUES (?)').run(name)
  db.close()
  const before = await readFile(file)
  const checked = await checkDatabase({ dialect: 'sqlite', file })
  expect(checked.status).toBe(state === 'all' ? 'pass' : state === 'pending' ? 'warning' : 'fail')
  expect(checked.message).toContain(
    state === 'all'
      ? `全部 ${names.length} 个迁移已执行`
      : state === 'pending'
        ? '1 个迁移没执行'
        : '2 个程序不认识的迁移，最大的是 9999_newest',
  )
  expect(await readFile(file)).toEqual(before)
})

test('数据目录不存在时寻找可写的祖先，不创建目录；存在时清除写入探测文件', async () => {
  const ctx = await context()
  const directory = join(ctx.root, 'missing', 'nested', 'data')
  expect((await checkDataDirectory(directory)).status).toBe('pass')
  await expect(stat(join(ctx.root, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await checkDataDirectory(ctx.root)).status).toBe('pass')
  expect((await readdir(ctx.root)).some((name) => name.startsWith('.doctor-'))).toBe(false)
})

test.each([200, 503])('服务持锁，健康检查响应 %i', async (status) => {
  const ctx = await context()
  const directory = join(ctx.root, 'data')
  const lock = await acquireDataLock(directory)
  const server = createServer((request, response) => {
    expect(request.url).toBe('/api/health')
    response.writeHead(status).end()
  })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const checked = await checkService(directory, '0.0.0.0', address.port)
    expect(checked.status).toBe(status === 200 ? 'pass' : 'fail')
    expect(checked.message).toContain(`http://127.0.0.1:${address.port}/api/health`)
  } finally {
    lock?.release()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
  expect((await checkService(directory, '127.0.0.1', 1)).message).toBe('没有服务在用这个数据目录')
  const available = await acquireDataLock(directory)
  expect(available).not.toBeNull()
  available?.release()
})

test('输出没有密钥、数据库密码和完整连接串，数据库连接失败时只写代码和位置', async () => {
  const ctx = await context()
  const url = 'mysql://user:hunter2-secret@127.0.0.1:1/db'
  const checked = await diagnose(ctx, { NEXTSKIN_SECRET: secret, NEXTSKIN_DATABASE_URL: url })
  expect(checked.code).toBe(1)
  expect(checked.output).toContain('[失败] 数据库：MySQL 127.0.0.1:1 / db；检查失败（ECONNREFUSED）')
  for (const value of [secret, 'hunter2', url]) expect(checked.output).not.toContain(value)
})

test('数据库整体检查有超时，驱动未完成握手也能返回', async () => {
  const sockets = new Set<Socket>()
  const server = createTcpServer((socket) => {
    sockets.add(socket)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address() as { port: number }
    const checked = await checkDatabase(
      { dialect: 'mysql', url: `mysql://user:private@127.0.0.1:${port}/db?connectTimeout=0` },
      100,
    )
    expect(checked).toMatchObject({ status: 'fail', timedOut: true })
    expect(checked.message).not.toContain('private')
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('plugin host 检查发行完整性，已知错误可回显、意外错误不回显', async () => {
  const ctx = await context()
  expect((await checkPluginHost(ctx, probeHost)).status).toBe('pass')
  expect(await checkPluginHost(ctx, () => Promise.reject(new HostStartError('plugin host 启动失败')))).toMatchObject({
    status: 'fail',
    message: 'plugin host 启动失败',
  })
  const unexpected = await checkPluginHost(ctx, () => Promise.reject(new Error(secret)))
  expect(unexpected.status).toBe('fail')
  expect(unexpected.message).not.toContain(secret)
  for (const file of ['server/packages/plugin-host/dist/host.mjs', 'server/apps/web/server.js']) {
    await rm(join(ctx.root, file))
    const incomplete = await checkPluginHost(ctx, probeHost)
    expect(incomplete.status).toBe('fail')
    expect(incomplete.message).toContain('发行目录不完整')
    await writeFile(join(ctx.root, file), '')
  }
})
