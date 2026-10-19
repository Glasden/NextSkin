import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createDatabase } from './database.ts'
import { ExclusiveLockBusyError, lockStatements, withExclusiveLock } from './exclusive-lock.ts'
import { dialectOf } from './helpers.ts'
import { createTestDatabase, testDialect, type TestDatabase } from './testing.ts'

let database: TestDatabase<object>
beforeAll(async () => {
  database = await createTestDatabase<object>()
})
afterAll(() => database.cleanup())

const server = testDialect() !== 'sqlite'

test('拿着锁时同名的锁立即报忙，别的名字不受影响；fn 抛错也会释放', async () => {
  const { db } = database
  const result = await withExclusiveLock(db, 'plugin:alpha', async () => {
    await expect(withExclusiveLock(db, 'plugin:alpha', () => Promise.resolve(1))).rejects.toBeInstanceOf(
      ExclusiveLockBusyError,
    )
    return 'alpha'
  })
  expect(result).toBe('alpha')
  await expect(withExclusiveLock(db, 'plugin:alpha', () => Promise.reject(new Error('迁移失败')))).rejects.toThrow(
    '迁移失败',
  )
  expect(await withExclusiveLock(db, 'plugin:alpha', () => Promise.resolve(2))).toBe(2)
})

test.skipIf(!server)('另一个进程（另一个连接池）拿着锁时也报忙', async () => {
  const other = createDatabase<object>(database.config)
  try {
    await withExclusiveLock(database.db, 'plugin:gamma', async () => {
      await expect(withExclusiveLock(other, 'plugin:gamma', () => Promise.resolve(1))).rejects.toBeInstanceOf(
        ExclusiveLockBusyError,
      )
    })
    expect(await withExclusiveLock(other, 'plugin:gamma', () => Promise.resolve(3))).toBe(3)
  } finally {
    await other.destroy()
  }
})

test.skipIf(!server)('连接池只有两条连接时，几个名字不同的锁同时拿也不会把池占满、互相卡死', async () => {
  if (database.config.dialect === 'sqlite') return
  const small = createDatabase<object>({ ...database.config, poolSize: 2 })
  try {
    const all = Promise.all(
      ['a', 'b', 'c', 'd'].map((name) =>
        withExclusiveLock(small, `plugin:${name}`, async () => {
          // fn 里的查询和事务从池里取别的连接
          await sql`select 1`.execute(small)
          await small.transaction().execute((tx) => sql`select 1`.execute(tx))
          return name
        }),
      ),
    )
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('卡死了')), 10_000))
    expect(await Promise.race([all, timeout])).toEqual(['a', 'b', 'c', 'd'])
  } finally {
    await small.destroy()
  }
})

test.skipIf(!server)('上次解锁失败、锁留在了连接池里的连接上：这条连接下次拿锁时先放掉，之后别人拿得到', async () => {
  if (database.config.dialect === 'sqlite') return
  // 只有一条连接的池：留着锁的就是下次拿到的那条
  const single = createDatabase<object>({ ...database.config, poolSize: 1 })
  try {
    const dialect = dialectOf(single)
    if (dialect === 'sqlite') return
    const statements = lockStatements(dialect, 'plugin:delta')
    await single.connection().execute(async (connection) => {
      expect(Number((await statements.acquire.execute(connection)).rows[0]?.acquired)).toBe(1)
    })
    await expect(withExclusiveLock(database.db, 'plugin:delta', () => Promise.resolve(1))).rejects.toBeInstanceOf(
      ExclusiveLockBusyError,
    )
    expect(await withExclusiveLock(single, 'plugin:delta', () => Promise.resolve('reused'))).toBe('reused')
    expect(await withExclusiveLock(database.db, 'plugin:delta', () => Promise.resolve('free'))).toBe('free')
  } finally {
    await single.destroy()
  }
})
