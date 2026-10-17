import { expect, test } from 'vitest'
import { coreConfigFromEnv } from './bootstrap.ts'

const dev = { cwd: '/srv/nextskin', production: false }
const prod = { cwd: '/srv/nextskin', production: true }
const secret = 'x'.repeat(32)

test('默认把 SQLite 和材质放在工作目录下的 data', () => {
  const config = coreConfigFromEnv({}, dev)
  expect(config.database).toEqual({ dialect: 'sqlite', file: '/srv/nextskin/data/nextskin.sqlite' })
  expect(config.textureDirectory).toBe('/srv/nextskin/data/textures')
})

test('数据目录和 SQLite 路径按工作目录解析', () => {
  const config = coreConfigFromEnv(
    { NEXTSKIN_DATA_DIR: 'storage', NEXTSKIN_DATABASE_URL: 'sqlite:db/site.sqlite' },
    dev,
  )
  expect(config.database).toEqual({ dialect: 'sqlite', file: '/srv/nextskin/db/site.sqlite' })
  expect(config.textureDirectory).toBe('/srv/nextskin/storage/textures')
})

test.each([
  ['mysql://u:p@db/nextskin', 'mysql'],
  ['postgres://u:p@db/nextskin', 'postgres'],
  ['postgresql://u:p@db/nextskin', 'postgres'],
])('%s 用 %s 方言', (url, dialect) => {
  expect(coreConfigFromEnv({ NEXTSKIN_DATABASE_URL: url, NEXTSKIN_SECRET: secret }, prod).database).toEqual({
    dialect,
    url,
  })
})

test('不认识的连接地址报错，且不回显地址（里面可能有密码）', () => {
  expect(() => coreConfigFromEnv({ NEXTSKIN_DATABASE_URL: 'mssql://u:hunter2@db/x' }, dev)).toThrow(
    /^NEXTSKIN_DATABASE_URL 的格式不对/,
  )
  try {
    coreConfigFromEnv({ NEXTSKIN_DATABASE_URL: 'mssql://u:hunter2@db/x' }, dev)
  } catch (error) {
    expect((error as Error).message).not.toContain('hunter2')
  }
})

test('生产环境必须设置 NEXTSKIN_SECRET，开发环境有固定的默认值', () => {
  expect(() => coreConfigFromEnv({}, prod)).toThrow(/NEXTSKIN_SECRET/)
  expect(coreConfigFromEnv({ NEXTSKIN_SECRET: secret }, prod).secretKey).toBe(secret)
  expect(coreConfigFromEnv({}, dev).secretKey.length).toBeGreaterThanOrEqual(32)
})
