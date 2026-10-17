import { MysqlDialect } from 'kysely'
import type { EventEmitter } from 'node:events'
import { afterEach, expect, test, vi } from 'vitest'
import { createDatabase } from './database.ts'
import { createPool } from 'mysql2'

const { pools } = vi.hoisted(() => ({ pools: [] as EventEmitter[] }))
vi.mock('mysql2', () => ({ createPool: vi.fn(() => ({ getConnection() {}, end() {} })) }))
vi.mock('pg', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    Pool: class extends EventEmitter {
      constructor() {
        super()
        pools.push(this)
      }
    },
  }
})
afterEach(() => {
  vi.clearAllMocks()
  pools.length = 0
})

test.each(['resetOnRelease', 'multipleStatements'])('MySQL 连接地址拒绝非白名单参数 %s，不回显参数值', (parameter) => {
  const secret = 'secret-url-option-value'
  expect(() => createDatabase({ dialect: 'mysql', url: `mysql://localhost/test?${parameter}=${secret}` })).toThrow(
    parameter,
  )
  try {
    createDatabase({ dialect: 'mysql', url: `mysql://localhost/test?${parameter}=${secret}` })
  } catch (error) {
    expect(String(error)).not.toContain(secret)
  }
  expect(createPool).not.toHaveBeenCalled()
})

test('MySQL 白名单 TLS 配置经过解析，不把原始 URL 交给驱动', () => {
  const ssl = { rejectUnauthorized: false }
  const query = encodeURIComponent(JSON.stringify(ssl))
  createDatabase({ dialect: 'mysql', url: `mysql://localhost/test?ssl=${query}&connectTimeout=2000` })
  expect(createPool).toHaveBeenCalledWith({
    host: 'localhost',
    port: 3306,
    user: '',
    password: '',
    database: 'test',
    charset: 'utf8mb4',
    timezone: 'Z',
    connectionLimit: 10,
    multipleStatements: false,
    resetOnRelease: false,
    flags: ['-LOCAL_FILES'],
    ssl,
    connectTimeout: 2000,
  })
})

test('PostgreSQL 连接池监听空闲连接的 error 事件', () => {
  createDatabase({ dialect: 'postgres', url: 'postgres://localhost/test' })
  expect(() => pools[0]!.emit('error', new Error('空闲连接已被服务器关闭'))).not.toThrow()
})

test('Kysely 等待新连接的会话设置完成后才交出连接', async () => {
  const calls: string[] = []
  const initialization = Promise.withResolvers<void>()
  const connection = {
    config: {},
    threadId: 1,
    connect() {},
    destroy() {},
    release() {},
    query: vi.fn((query: string, _parameters: unknown, callback?: (error: unknown, result: unknown) => void) => {
      calls.push(query)
      if (query === 'setup') void initialization.promise.then(() => callback?.(null, []))
      else callback?.(null, [])
      return {
        stream: () => ({
          async *[Symbol.asyncIterator]() {
            yield await Promise.resolve([])
          },
        }),
      }
    }),
  }
  const dialect = new MysqlDialect({
    pool: {
      getConnection: (callback) => callback(null, connection),
      end: (callback) => callback(null),
    },
    onCreateConnection: async (created) => {
      const { CompiledQuery } = await import('kysely')
      await created.executeQuery(CompiledQuery.raw('setup'))
    },
  })
  const driver = dialect.createDriver()
  await driver.init()
  let acquired = false
  const pending = driver.acquireConnection().then((value) => {
    acquired = true
    return value
  })

  await vi.waitFor(() => expect(calls).toEqual(['setup']))
  expect(acquired).toBe(false)
  initialization.resolve()
  const created = await pending
  await driver.releaseConnection(created)
  await driver.destroy()
})

test('连接地址和连接池大小无效时不泄露凭据', () => {
  for (const url of ['bad://user:secret@[', 'mysql://user:%ZZ@localhost/db']) {
    try {
      createDatabase({ dialect: 'mysql', url })
      expect.unreachable()
    } catch (error) {
      expect(String(error)).not.toContain('secret')
      expect(String(error)).not.toContain(url)
    }
  }
  expect(() => createDatabase({ dialect: 'mysql', url: 'mysql://localhost/db', poolSize: 0 })).toThrow(/poolSize/)
})

test('MySQL 连接关闭 LOCAL_FILES 能力', () => {
  createDatabase({ dialect: 'mysql', url: 'mysql://localhost/test' })
  expect(vi.mocked(createPool).mock.calls[0]?.[0]).toHaveProperty('flags', ['-LOCAL_FILES'])
})
