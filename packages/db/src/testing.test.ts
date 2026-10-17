import { Kysely, PostgresDialect } from 'kysely'
import { afterEach, expect, test, vi } from 'vitest'
import { createDatabase } from './database.ts'
import { createTestDatabase, testDatabaseAdminUrl } from './testing.ts'

vi.mock('./database.ts', () => ({ createDatabase: vi.fn() }))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetAllMocks()
})

test('测试库创建失败时保留已脱敏的原因并关闭管理员连接', async () => {
  vi.stubEnv('NEXTSKIN_TEST_DB', 'postgres')
  vi.stubEnv('NEXTSKIN_TEST_POSTGRES_URL', 'postgres://localhost/unused')
  const failure = new Error('连接被拒绝')
  const end = vi.fn(() => Promise.resolve())
  // 用假连接池触发失败，不连接数据库服务器。
  const admin = new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: { options: {}, connect: () => Promise.reject(failure), end },
    }),
  })
  vi.mocked(createDatabase).mockReturnValue(admin)
  const creation = createTestDatabase()
  await expect(creation).rejects.toThrow('创建独立的 postgres 测试数据库失败')
  await expect(creation).rejects.toMatchObject({ cause: failure })
  expect(end).toHaveBeenCalledOnce()
})

test.each([
  { dialect: 'mysql', port: '33306', variable: 'NEXTSKIN_TEST_MYSQL_URL', protocol: 'mysql' },
  { dialect: 'mariadb', port: '33307', variable: 'NEXTSKIN_TEST_MARIADB_URL', protocol: 'mysql' },
  { dialect: 'postgres', port: '35432', variable: 'NEXTSKIN_TEST_POSTGRES_URL', protocol: 'postgres' },
])('$dialect 管理员地址使用默认值并支持环境变量覆盖', ({ dialect, port, variable, protocol }) => {
  vi.stubEnv('NEXTSKIN_TEST_DB', dialect)
  vi.stubEnv(variable, undefined)
  const defaults = new URL(testDatabaseAdminUrl()!)
  expect(defaults.hostname).toBe('127.0.0.1')
  expect(defaults.port).toBe(port)
  const override = `${protocol}://example.invalid/custom_database`
  vi.stubEnv(variable, override)
  expect(testDatabaseAdminUrl()).toBe(override)
})

test('SQLite 没有服务器管理员连接地址', () => {
  vi.stubEnv('NEXTSKIN_TEST_DB', 'sqlite')
  expect(testDatabaseAdminUrl()).toBeUndefined()
})
