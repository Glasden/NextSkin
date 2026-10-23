import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTestDirectory } from '@nextskin/db/testing'
import { afterEach, expect, test } from 'vitest'
import { ConfigError, readConfig } from './config.ts'
import type { LauncherContext } from './context.ts'

const directories: string[] = []
afterEach(async () => {
  for (const path of directories.splice(0)) await removeTestDirectory(path)
})
async function context(): Promise<LauncherContext> {
  const root = await mkdtemp(join(tmpdir(), 'launcher-config-'))
  directories.push(root)
  return { root, cwd: join(root, 'elsewhere'), source: false, production: true, version: '0.0.0' }
}
const secret = 's'.repeat(32)

test('环境优先于 .env，配置和 SQLite 相对路径按根目录解析，覆盖 HOSTNAME', async () => {
  const ctx = await context()
  await writeFile(
    join(ctx.root, '.env'),
    'NEXTSKIN_DATA_DIR=from-file\nNEXTSKIN_SECRET=from-file\nNEXTSKIN_DATABASE_URL=sqlite:db/site.sqlite\nNEXTSKIN_HOST=127.0.0.1\n',
  )
  const env: NodeJS.ProcessEnv = { NEXTSKIN_SECRET: secret, NEXTSKIN_DATA_DIR: 'storage', HOSTNAME: 'inherited' }
  const result = await readConfig(ctx, env)
  expect(env.NEXTSKIN_HOST).toBe('127.0.0.1')
  expect(result.config.secretKey).toBe(secret)
  expect(result.config.dataDirectory).toBe(join(ctx.root, 'storage'))
  expect(result.config.database).toEqual({ dialect: 'sqlite', file: join(ctx.root, 'db/site.sqlite') })
  expect(result.env).toMatchObject({
    NODE_ENV: 'production',
    HOSTNAME: '127.0.0.1',
    NEXTSKIN_DATA_DIR: join(ctx.root, 'storage'),
    NEXTSKIN_DATABASE_URL: `sqlite:${join(ctx.root, 'db/site.sqlite')}`,
  })
})

test('NEXTSKIN_ENV_FILE 相对根目录解析，MySQL 和 PostgreSQL 地址原样传给核心', async () => {
  const ctx = await context()
  await writeFile(join(ctx.root, 'custom.env'), `NEXTSKIN_SECRET=${secret}\n`)
  for (const url of ['mysql://u:p@db/site', 'postgres://u:p@db/site']) {
    const result = await readConfig(ctx, { NEXTSKIN_ENV_FILE: 'custom.env', NEXTSKIN_DATABASE_URL: url })
    expect(result.env.NEXTSKIN_DATABASE_URL).toBe(url)
    expect(result.env.NEXTSKIN_ENV_FILE).toBe(join(ctx.root, 'custom.env'))
  }
})

test.each([
  [{}, 3000],
  [{ PORT: '4000' }, 4000],
  [{ PORT: '4000', NEXTSKIN_PORT: '5000' }, 5000],
  [{ NEXTSKIN_PORT: '65535' }, 65535],
] as const)('端口优先级 %j', async (env, port) => {
  const result = await readConfig(await context(), { NEXTSKIN_SECRET: secret, ...env })
  expect(result.port).toBe(port)
  expect(result.env.PORT).toBe(String(port))
  expect(result.env.HOSTNAME).toBe('0.0.0.0')
})

test.each(['', '0', '65536', '-1', '1.5', 'abc', '1e3', ' 80'])('非法端口 %j 是配置错误', async (port) => {
  await expect(readConfig(await context(), { NEXTSKIN_SECRET: secret, NEXTSKIN_PORT: port })).rejects.toThrow(
    ConfigError,
  )
})

test('自动生成随机密钥和 0600 文件，提示中不含密钥', async () => {
  const ctx = await context()
  const warnings: string[] = []
  const result = await readConfig(ctx, {}, (message) => warnings.push(message))
  const key = result.config.secretKey
  expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(await readFile(join(ctx.root, '.env'), 'utf8')).toContain(`NEXTSKIN_SECRET=${key}`)
  if (process.platform !== 'win32') expect((await stat(join(ctx.root, '.env'))).mode & 0o777).toBe(0o600)
  expect(warnings.join()).toContain('请备份这个文件')
  expect(warnings.join()).not.toContain(key)
})

test('已有 .env 没密钥时报错，不更改文件；生产环境拒绝短密钥', async () => {
  const ctx = await context()
  const file = join(ctx.root, '.env')
  await writeFile(file, '# keep\nPORT=3000\n')
  await expect(readConfig(ctx, {})).rejects.toThrow(/里没有 NEXTSKIN_SECRET/)
  expect(await readFile(file, 'utf8')).toBe('# keep\nPORT=3000\n')
  await expect(readConfig(ctx, { NEXTSKIN_SECRET: 'short' })).rejects.toThrow(/至少要有 32/)
})

test('源码模式不生成 .env，开发环境使用固定密钥', async () => {
  const ctx = await context()
  const result = await readConfig({ ...ctx, source: true, production: false }, {})
  expect(result.config.secretKey.length).toBeGreaterThanOrEqual(32)
  await expect(stat(join(ctx.root, '.env'))).rejects.toThrow()
})

test('连接地址错误不回显连接串或密码', async () => {
  await expect(
    readConfig(await context(), { NEXTSKIN_SECRET: secret, NEXTSKIN_DATABASE_URL: 'bad://u:private@db/site' }),
  ).rejects.toThrow(/^NEXTSKIN_DATABASE_URL 的格式不对/)
})

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('不可写根目录提示使用环境变量', async () => {
  const ctx = await context()
  await chmod(ctx.root, 0o500)
  try {
    await expect(readConfig(ctx, {})).rejects.toThrow(/请用环境变量 NEXTSKIN_SECRET/)
  } finally {
    await chmod(ctx.root, 0o700)
  }
})

test('源码模式也按合并后的 NODE_ENV 校验生产配置', async () => {
  const ctx = await context()
  await writeFile(join(ctx.root, '.env'), 'NODE_ENV=production\nNEXTSKIN_SECRET=short\n')
  await expect(readConfig({ ...ctx, source: true, production: false }, {})).rejects.toThrow(/至少要有 32/)
})
