import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CompiledQuery, sql, type Kysely } from 'kysely'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createDatabase } from '../database.ts'
import { SqliteWalDialect, SqliteWriteLockTimeoutError } from './dialect.ts'

interface Schema {
  items: { n: number }
}
let directory: string
let file: string
let db: Kysely<Schema>
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nextskin-sqlite-'))
  file = join(directory, 'db.sqlite')
  db = createDatabase<Schema>({ dialect: 'sqlite', file, busyTimeoutMs: 5, lockTimeoutMs: 100 })
  await db.schema
    .createTable('items')
    .addColumn('n', 'integer', (c) => c.notNull().unique())
    .execute()
  await db.insertInto('items').values({ n: 1 }).execute()
})
afterEach(async () => {
  try {
    await db.destroy()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('写事务进行中，事务外 SELECT 仍能读取已提交的快照', async () => {
  await db.transaction().execute(async (trx) => {
    await trx.updateTable('items').set({ n: 2 }).execute()
    expect(await db.selectFrom('items').select('n').execute()).toEqual([{ n: 1 }])
    expect(await trx.selectFrom('items').select('n').execute()).toEqual([{ n: 2 }])
  })
  expect(await db.selectFrom('items').select('n').execute()).toEqual([{ n: 2 }])
})

test('事务外写入和原始 SQL 排在事务之后执行', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const transaction = db.transaction().execute(async (trx) => {
    await trx.updateTable('items').set({ n: 2 }).execute()
    entered.resolve()
    await release.promise
  })
  await entered.promise
  let finished = false
  const write = db
    .insertInto('items')
    .values({ n: 3 })
    .execute()
    .then(() => {
      finished = true
    })
  const raw = sql<{ n: number }>`select n from items order by n`.execute(db)
  try {
    await db.selectFrom('items').selectAll().execute()
    expect(finished).toBe(false)
  } finally {
    release.resolve()
  }
  await transaction
  await write
  expect((await raw).rows).toEqual([{ n: 2 }, { n: 3 }])
})

test('回滚移除未提交的数据并释放写锁', async () => {
  await expect(
    db.transaction().execute(async (trx) => {
      await trx.insertInto('items').values({ n: 9 }).execute()
      throw new Error('主动中止事务')
    }),
  ).rejects.toThrow('主动中止事务')
  await db.insertInto('items').values({ n: 3 }).execute()
  expect(await db.selectFrom('items').selectAll().orderBy('n').execute()).toEqual([{ n: 1 }, { n: 3 }])
})

test('SQLite 已结束事务时保留调用方错误并释放写锁', async () => {
  const failure = new Error('事务回调主动失败')
  await expect(
    db.transaction().execute(async (trx) => {
      await trx.insertInto('items').values({ n: 9 }).execute()
      await sql`insert or rollback into items values (null)`.execute(trx).catch(() => {})
      throw failure
    }),
  ).rejects.toBe(failure)
  await db.insertInto('items').values({ n: 3 }).execute()
  expect(await db.selectFrom('items').selectAll().orderBy('n').execute()).toEqual([{ n: 1 }, { n: 3 }])
})

async function deferredForeignKey(): Promise<void> {
  await sql`create table parent (id integer primary key)`.execute(db)
  await sql`create table child (id integer references parent(id) deferrable initially deferred)`.execute(db)
}

test('提交失败后 Kysely 自动回滚，写锁只释放一次', async () => {
  await deferredForeignKey()
  await expect(
    db.transaction().execute(async (trx) => {
      await sql`insert into child values (42)`.execute(trx)
    }),
  ).rejects.toThrow(/FOREIGN KEY/)
  await db.transaction().execute(async (trx) => {
    await trx.insertInto('items').values({ n: 4 }).execute()
  })
  await db.insertInto('items').values({ n: 5 }).execute()
  expect((await sql`select * from child`.execute(db)).rows).toEqual([])
})

test('受控事务提交失败后保留写锁，直到显式回滚', async () => {
  await deferredForeignKey()
  const trx = await db.startTransaction().execute()
  try {
    await sql`insert into child values (42)`.execute(trx)
    await expect(trx.commit().execute()).rejects.toThrow(/FOREIGN KEY/)
  } finally {
    await trx.rollback().execute()
  }
  await db.insertInto('items').values({ n: 5 }).execute()
})

test('保存点名称正确转义，回滚仅撤销保存点之后的写入', async () => {
  const trx = await db.startTransaction().execute()
  try {
    const saved = await trx.savepoint('a"; drop table items; --').execute()
    await saved.insertInto('items').values({ n: 9 }).execute()
    await saved.rollbackToSavepoint('a"; drop table items; --').execute()
    await saved.releaseSavepoint('a"; drop table items; --').execute()
    await saved.commit().execute()
  } catch (error) {
    await trx.rollback().execute()
    throw error
  }
  expect(await db.selectFrom('items').selectAll().execute()).toEqual([{ n: 1 }])
})

test('事务内误用外层 db 写入会超时，等待者移除后写锁仍可用', async () => {
  await expect(
    db.transaction().execute(async () => {
      await db.insertInto('items').values({ n: 8 }).execute()
    }),
  ).rejects.toThrow(SqliteWriteLockTimeoutError)
  await db.transaction().execute(async (trx) => {
    await trx.insertInto('items').values({ n: 2 }).execute()
  })
  await db.insertInto('items').values({ n: 3 }).execute()
  expect(await db.selectFrom('items').select('n').orderBy('n').execute()).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
})

test('begin immediate 失败后释放进程内写锁', async () => {
  const external = new DatabaseSync(file)
  try {
    external.exec('begin immediate')
    await expect(db.transaction().execute(() => Promise.resolve())).rejects.toThrow(/locked/)
    external.exec('rollback')
    await db.insertInto('items').values({ n: 4 }).execute()
  } finally {
    external.close()
  }
})

test('流式查询报错并提示替代方式', async () => {
  await expect(
    (async () => {
      for await (const row of db.selectFrom('items').selectAll().stream()) void row
    })(),
  ).rejects.toThrow(/不支持流式查询/)
})

test('连接应用 PRAGMA 和超时配置', async () => {
  expect((await sql`pragma journal_mode`.execute(db)).rows).toEqual([{ journal_mode: 'wal' }])
  expect((await sql`pragma foreign_keys`.execute(db)).rows).toEqual([{ foreign_keys: 1 }])
  expect((await sql`pragma synchronous`.execute(db)).rows).toEqual([{ synchronous: 1 }])
  expect((await sql`pragma busy_timeout`.execute(db)).rows).toEqual([{ timeout: 5 }])
  expect(() => createDatabase({ dialect: 'sqlite', file, busyTimeoutMs: -1 })).toThrow(RangeError)
  expect(() => createDatabase({ dialect: 'sqlite', file: ':memory:' })).toThrow(/需要共享文件/)
})

test('SQLite 自动回滚后拒绝继续读写，不产生自动提交', async () => {
  await expect(
    db.transaction().execute(async (trx) => {
      await expect(sql`insert or rollback into items values (1)`.execute(trx)).rejects.toThrow()
      await expect(trx.insertInto('items').values({ n: 2 }).execute()).rejects.toThrow(/SQLite 回滚.*重试整个事务/)
      await expect(trx.selectFrom('items').selectAll().execute()).rejects.toThrow(/SQLite 回滚.*重试整个事务/)
    }),
  ).rejects.toThrow(/SQLite 回滚.*重试整个事务/)
  expect(await db.selectFrom('items').selectAll().execute()).toEqual([{ n: 1 }])
  await db.insertInto('items').values({ n: 3 }).execute()
})

test('原始事务控制语句及其缓存不能绕过写锁，合法查询不受影响', async () => {
  await db.connection().execute(async (connection) => {
    for (const command of ['begin immediate', 'CoMmIt', 'end', 'rollback', 'savepoint x', 'release x']) {
      const query = ` \n-- 前导注释\n/* 块注释 */ ${command}`
      await expect(sql.raw(query).execute(connection)).rejects.toThrow(
        /db.transaction\(\).*startTransaction\(\).*savepoint\(\)/,
      )
    }
  })
  await db.transaction().execute(async (trx) => {
    await trx.selectFrom('items').selectAll().execute()
  })
  for (const statement of [
    'commit',
    'begin immediate',
    '/* block */ END',
    'bEgIn',
    '-- line\nSAVEPOINT outer_point',
    'release outer_point',
  ]) {
    await expect(sql.raw(statement).execute(db)).rejects.toThrow(/禁止通过原始 SQL 控制事务/)
  }
  expect((await sql`pragma foreign_keys`.execute(db)).rows).toEqual([{ foreign_keys: 1 }])
  expect((await sql`with seed(n) as (select 9) select n as ending from seed`.execute(db)).rows).toEqual([{ ending: 9 }])
  await db.transaction().execute(async (trx) => {
    await trx.insertInto('items').values({ n: 2 }).execute()
  })
})

test('销毁立即拒绝写锁等待者并清除计时器，之后不能获取连接', async () => {
  const driver = new SqliteWalDialect({ file, lockTimeoutMs: 2147483647 }).createDriver()
  await driver.init()
  const transaction = await driver.acquireConnection()
  const waiter = await driver.acquireConnection()
  await driver.beginTransaction(transaction, {})
  vi.useFakeTimers()
  let outcome: unknown
  const pending = waiter.executeQuery(CompiledQuery.raw('insert into items values (2)')).catch((error: unknown) => {
    outcome = error
  })
  try {
    await Promise.resolve()
    expect(vi.getTimerCount()).toBe(1)
    await driver.destroy()
    await vi.advanceTimersByTimeAsync(0)
    expect(outcome).toBeInstanceOf(Error)
    expect(String(outcome)).toContain('数据库已关闭')
    expect(vi.getTimerCount()).toBe(0)
    await expect(driver.acquireConnection()).rejects.toThrow(/数据库已关闭/)
    await expect(waiter.executeQuery(CompiledQuery.raw('insert into items values (3)'))).rejects.toThrow(/数据库已关闭/)
  } finally {
    await vi.runAllTimersAsync()
    await pending
    vi.useRealTimers()
  }
})

test('SQLite 自动回滚后受控事务的保存点和提交也拒绝执行', async () => {
  const trx = await db.startTransaction().execute()
  try {
    await expect(sql`insert or rollback into items values (1)`.execute(trx)).rejects.toThrow()
    await expect(trx.savepoint('after_abort').execute()).rejects.toThrow(/SQLite 回滚.*重试整个事务/)
    await expect(trx.commit().execute()).rejects.toThrow(/SQLite 回滚.*重试整个事务/)
  } finally {
    await trx.rollback().execute()
  }
  await db.insertInto('items').values({ n: 3 }).execute()
})

test('authorizer 拒绝裸回车注释后的 COMMIT，事务仍可回滚', async () => {
  const failure = new Error('调用方要求回滚')
  await expect(
    db.transaction().execute(async (trx) => {
      await trx.insertInto('items').values({ n: 2 }).execute()
      await expect(sql.raw('-- prefix\r still comment\nCOMMIT').execute(trx)).rejects.toThrow(
        /禁止通过原始 SQL 控制事务/,
      )
      throw failure
    }),
  ).rejects.toBe(failure)
  expect(await db.selectFrom('items').selectAll().execute()).toEqual([{ n: 1 }])
  await db.insertInto('items').values({ n: 3 }).execute()
})

test('固定连接上的新事务重置 SQLite 终止标记', async () => {
  await db.connection().execute(async (connection) => {
    await expect(
      connection.transaction().execute(async (trx) => {
        await sql`insert or rollback into items values (1)`.execute(trx).catch(() => {})
        await trx.selectFrom('items').selectAll().execute()
      }),
    ).rejects.toThrow(/SQLite 回滚/)
    await connection.transaction().execute(async (trx) => {
      await trx.insertInto('items').values({ n: 2 }).execute()
    })
  })
  expect(await db.selectFrom('items').selectAll().orderBy('n').execute()).toEqual([{ n: 1 }, { n: 2 }])
})

test('最外层保存点不能被用户 release，读连接也拒绝写入和事务控制', async () => {
  const driver = new SqliteWalDialect({ file }).createDriver() as import('kysely').Driver & {
    writer: import('./dialect.ts').Backend
    reader: import('./dialect.ts').Backend
  }
  await driver.init()
  try {
    // 直接验证 Backend 边界，模拟驱动已有最外层保存点的情况。
    await driver.writer.executeControl('savepoint outer_point')
    await driver.writer.execute('insert into items values (2)', [])
    await expect(driver.writer.execute('release outer_point', [])).rejects.toThrow(/禁止通过原始 SQL 控制事务/)
    expect(await driver.writer.isInTransaction()).toBe(true)
    await driver.writer.executeControl('rollback')
    for (const statement of ['begin immediate', 'commit', 'end', 'savepoint x', 'release x']) {
      await expect(driver.reader.execute(statement, [])).rejects.toThrow(/禁止通过原始 SQL 控制事务/)
    }
    for (const statement of ['insert into items values (3)', 'delete from items', 'pragma user_version=10']) {
      await expect(driver.reader.execute(statement, [])).rejects.toThrow(/只读连接拒绝写入/)
    }
    expect((await driver.reader.execute('PRAGMA TABLE_INFO(items)', [])).rows).toHaveLength(1)
    expect((await driver.reader.execute('with x(n) as (select 8) select n as end_value from x', [])).rows).toEqual([
      { end_value: 8 },
    ])
    expect(await db.selectFrom('items').selectAll().execute()).toEqual([{ n: 1 }])
  } finally {
    if (await driver.writer.isInTransaction()) await driver.writer.executeControl('rollback')
    await driver.destroy()
  }
})
