import { sql, type Generated, type Kysely, type KyselyPlugin } from 'kysely'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { autoIncrementId, countRows, createTable, dialectOf, upsert } from './index.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

interface Schema {
  items: { id: Generated<number>; name: string; alternate: string | null; n: Generated<number> }
  nullable: { id: Generated<number>; name: string | null; n: number }
}
let database: TestDatabase<Schema>
let db: Kysely<Schema>
beforeAll(async () => {
  database = await createTestDatabase<Schema>()
  db = database.db
  await createTable(db, 'items')
    .$call(autoIncrementId(db))
    .addColumn('name', 'varchar(100)', (c) => c.notNull().unique())
    .addColumn('alternate', 'varchar(100)', (c) => c.unique())
    .addColumn('n', 'integer', (c) => c.notNull().defaultTo(7))
    .execute()
  await createTable(db, 'nullable')
    .$call(autoIncrementId(db))
    .addColumn('name', 'varchar(100)', (c) => c.unique())
    .addColumn('n', 'integer')
    .execute()
})
afterAll(async () => {
  await database?.cleanup()
})
beforeEach(async () => {
  await db.deleteFrom('items').execute()
})
const item = (name: string, alternate: string | null = null, n = 1) => ({ name, alternate, n })
const countedItem = (name: string, n = 1) => ({ name, n, alternate: null })

test('多行 upsert 用本次插入值更新已有行，并插入新行', async () => {
  await db.insertInto('items').values(countedItem('old', 1)).execute()
  await upsert(db, 'items', {
    values: [countedItem('old', 7), countedItem('new', 8)],
    conflict: ['name'],
    update: ['n'],
  })
  expect(await db.selectFrom('items').select(['name', 'n']).orderBy('name').execute()).toEqual([
    { name: 'new', n: 8 },
    { name: 'old', n: 7 },
  ])
})

test('upsert 在事务中支持引用已有行的更新表达式', async () => {
  await db.transaction().execute(async (trx) => {
    await upsert(trx, 'items', {
      values: countedItem('counter', 4),
      conflict: ['name'],
      update: { n: sql<number>`${sql.ref('items.n')} + 1` },
    })
    await upsert(trx, 'items', {
      values: countedItem('counter', 99),
      conflict: ['name'],
      update: (eb) => ({ n: eb('items.n', '+', 1) }),
    })
    await upsert(trx, 'items', {
      values: countedItem('counter', 99),
      conflict: ['name'],
      update: { n: sql<number>`${sql.ref('items.n')} + 2` },
    })
  })
  expect(await db.selectFrom('items').select('n').executeTakeFirstOrThrow()).toEqual({ n: 7 })
})

test('upsert 在其他唯一键上冲突时拒绝写入，不修改另一行', async () => {
  await db.insertInto('items').values(item('A', 'x')).execute()
  await expect(upsert(db, 'items', { values: item('B', 'x', 9), conflict: ['name'], update: ['n'] })).rejects.toThrow()
  expect(await db.selectFrom('items').select(['name', 'n']).execute()).toEqual([{ name: 'A', n: 1 }])
})

test('多行 upsert 中途失败时全部回滚，已有事务由调用方回滚', async () => {
  await db.insertInto('items').values(item('A', 'x')).execute()
  const values = [item('B', 'y', 2), item('C', 'x', 9)]
  await expect(upsert(db, 'items', { values, conflict: ['name'], update: ['n'] })).rejects.toThrow()
  expect(await db.selectFrom('items').select(['name', 'n']).execute()).toEqual([{ name: 'A', n: 1 }])
  await expect(
    db.transaction().execute((trx) => upsert(trx, 'items', { values, conflict: ['name'], update: ['n'] })),
  ).rejects.toThrow()
  expect(await countRows(db.selectFrom('items'))).toBe(1)
})

test('upsert 更新值未变化时仍算命中已有行', async () => {
  await db.insertInto('items').values(item('A')).execute()
  await upsert(db, 'items', { values: item('A', 'different'), conflict: ['name'], update: ['n'] })
  expect(await countRows(db.selectFrom('items'))).toBe(1)
  expect(await db.selectFrom('items').select('alternate').executeTakeFirstOrThrow()).toEqual({ alternate: null })
})

test('upsert 的 null 冲突列不匹配已有行，也不被当作批次重复键', async () => {
  await upsert(db, 'nullable', {
    values: [
      { name: null, n: 1 },
      { name: null, n: 2 },
    ],
    conflict: ['name'],
    update: ['n'],
  })
  expect(await db.selectFrom('nullable').select('n').orderBy('n').execute()).toEqual([{ n: 1 }, { n: 2 }])
})

test('批次重复冲突键在执行前拒绝，不使事务失效', async () => {
  await db.transaction().execute(async (trx) => {
    await expect(
      upsert(trx, 'items', { values: [item('A'), item('A')], conflict: ['name'], update: ['n'] }),
    ).rejects.toThrow(/重复冲突键/)
    expect(await countRows(trx.selectFrom('items'))).toBe(0)
    await trx.insertInto('items').values(item('usable')).execute()
  })
})

test('upsert 冲突列不能使用表达式', async () => {
  await expect(
    upsert(db, 'items', { values: { ...item('A'), name: sql<string>`'A'` }, conflict: ['name'], update: ['n'] }),
  ).rejects.toThrow(/冲突列.*表达式/)
  expect(await countRows(db.selectFrom('items'))).toBe(0)
})

test('MySQL 并发插入同一冲突键后重试更新，且不嵌套调用方事务', async () => {
  // 此用例专门验证 MySQL 的多语句实现；READ COMMITTED 让缺失行的 UPDATE 不锁住插入间隙。
  if (dialectOf(db) !== 'mysql') return
  let inserted = false
  const race: KyselyPlugin = {
    transformQuery: ({ node }) => node,
    transformResult: async ({ result }) => {
      if (!inserted && result.numAffectedRows === 0n) {
        inserted = true
        await db
          .insertInto('items')
          .values(item('racing', null, 5))
          .execute()
      }
      return result
    },
  }
  await db
    .transaction()
    .setIsolationLevel('read committed')
    .execute(async (trx) => {
      await upsert(trx.withPlugin(race), 'items', {
        values: item('racing', null, 9),
        conflict: ['name'],
        update: ['n'],
      })
    })
  expect(inserted).toBe(true)
  expect(await db.selectFrom('items').select(['name', 'n']).execute()).toEqual([{ name: 'racing', n: 9 }])
})

test('并发事务对同一个新键计数 upsert，两次均成功且计数为 2', async () => {
  let arrivals = 0
  const ready = Promise.withResolvers<void>()
  const gate: KyselyPlugin = {
    transformQuery: ({ node }) => node,
    transformResult: async ({ result }) => {
      // 仅 MySQL 的 UPDATE/INSERT 两步实现需要把两个首次 UPDATE 放在同一竞争窗口。
      if (dialectOf(db) === 'mysql' && result.numAffectedRows === 0n && arrivals < 2) {
        if (++arrivals === 2) ready.resolve()
        await ready.promise
      }
      return result
    },
  }
  const results = await Promise.allSettled(
    [1, 2].map(() =>
      db.transaction().execute((trx) =>
        upsert(trx.withPlugin(gate), 'items', {
          values: { name: 'new', n: 1 },
          conflict: ['name'],
          update: (eb) => ({ n: eb('items.n', '+', 1) }),
        }),
      ),
    ),
  )
  expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled'])
  expect(await db.selectFrom('items').select('n').execute()).toEqual([{ n: 2 }])
})

test('MySQL 自有事务遇到死锁整体重试，最多执行三次', async () => {
  // 注入服务器死锁码，确定性验证整个事务重跑及每次失败后的回滚。
  if (dialectOf(db) !== 'mysql') return
  let attempts = 0
  const failure = Object.assign(new Error('模拟服务器死锁'), { errno: 1213 })
  const inject: KyselyPlugin = {
    transformQuery: ({ node }) => node,
    transformResult: ({ result }) => {
      if (result.numAffectedRows === 1n && ++attempts <= 2) return Promise.reject(failure)
      return Promise.resolve(result)
    },
  }
  await upsert(db.withPlugin(inject), 'items', { values: { name: 'retry', n: 1 }, conflict: ['name'], update: ['n'] })
  expect(attempts).toBe(3)
  expect(await countRows(db.selectFrom('items'))).toBe(1)
})

test('update 列名数组的每一列必须在每一行有值，不能依赖数据库默认值', async () => {
  await expect(upsert(db, 'items', { values: { name: 'A' }, conflict: ['name'], update: ['n'] })).rejects.toThrow(
    /更新列 n.*没有值/,
  )
  await expect(
    upsert(db, 'items', {
      values: [
        { name: 'A', n: 1 },
        { name: 'B', n: undefined },
      ],
      conflict: ['name'],
      update: ['n'],
    }),
  ).rejects.toThrow(/更新列 n.*没有值/)
  expect(await countRows(db.selectFrom('items'))).toBe(0)
})

test('update 的列名数组和单行对象都不能修改冲突列', async () => {
  await expect(
    upsert(db, 'items', { values: { name: 'A', n: 1 }, conflict: ['name'], update: ['name'] }),
  ).rejects.toThrow(/不能更新冲突列/)
  await expect(
    upsert(db, 'items', { values: { name: 'A', n: 1 }, conflict: ['name'], update: { name: 'B' } }),
  ).rejects.toThrow(/不能更新冲突列/)
})

test('多行 upsert 只接受列名数组更新，单行仍可使用表达式工厂', async () => {
  const values = [
    { name: 'A', n: 1 },
    { name: 'B', n: 2 },
  ]
  await expect(upsert(db, 'items', { values, conflict: ['name'], update: { name: 'B' } })).rejects.toThrow(
    /多行 upsert.*列名数组/,
  )
  await expect(
    upsert(db, 'items', { values, conflict: ['name'], update: (eb) => ({ n: eb('items.n', '+', 1) }) }),
  ).rejects.toThrow(/多行 upsert.*列名数组/)
  expect(await countRows(db.selectFrom('items'))).toBe(0)
  await db.insertInto('items').values({ name: 'A', n: 1 }).execute()
  await upsert(db, 'items', {
    values: { name: 'A', n: 99 },
    conflict: ['name'],
    update: (eb) => ({ n: eb('items.n', '+', 1) }),
  })
  expect(await db.selectFrom('items').select(['name', 'n']).execute()).toEqual([{ name: 'A', n: 2 }])
})

test('MySQL 自有事务重试达到三次后抛错，调用方事务不自动重试', async () => {
  if (dialectOf(db) !== 'mysql') return
  let attempts = 0
  const failure = Object.assign(new Error('模拟持续死锁'), { errno: 1213 })
  const inject: KyselyPlugin = {
    transformQuery: ({ node }) => node,
    transformResult: ({ result }) => {
      if (result.numAffectedRows === 1n) {
        attempts++
        return Promise.reject(failure)
      }
      return Promise.resolve(result)
    },
  }
  const options = { values: { name: 'retry', n: 1 }, conflict: ['name'] as const, update: ['n'] as const }
  await expect(upsert(db.withPlugin(inject), 'items', options)).rejects.toBe(failure)
  expect(attempts).toBe(3)
  expect(await countRows(db.selectFrom('items'))).toBe(0)
  attempts = 0
  await expect(db.transaction().execute((trx) => upsert(trx.withPlugin(inject), 'items', options))).rejects.toBe(
    failure,
  )
  expect(attempts).toBe(1)
  expect(await countRows(db.selectFrom('items'))).toBe(0)
})

test('upsert 拒绝空的冲突列或更新列数组', async () => {
  await expect(upsert(db, 'items', { values: item('a'), conflict: [], update: ['n'] })).rejects.toThrow(/缺少冲突列/)
  await expect(upsert(db, 'items', { values: item('a'), conflict: ['name'], update: [] })).rejects.toThrow(/缺少更新列/)
})

test('单行表达式工厂不能修改冲突列，拒绝时不执行写入', async () => {
  await db
    .insertInto('items')
    .values(item('A', null, 1))
    .execute()
  await expect(
    upsert(db, 'items', {
      values: item('A', null, 2),
      conflict: ['name'],
      update: () => ({ name: 'B', n: 2 }),
    }),
  ).rejects.toThrow(/不能更新冲突列 name/)
  expect(await db.selectFrom('items').select(['name', 'n']).execute()).toEqual([{ name: 'A', n: 1 }])
})

test('表达式工厂只求值一次，并执行检查过的更新', async () => {
  await db
    .insertInto('items')
    .values(item('A', null, 1))
    .execute()
  let evaluations = 0
  await upsert(db, 'items', {
    values: item('A', null, 99),
    conflict: ['name'],
    update: () => {
      evaluations++
      return { n: 2 }
    },
  })
  expect(evaluations).toBe(1)
  expect(await db.selectFrom('items').select(['name', 'n']).execute()).toEqual([{ name: 'A', n: 2 }])
})
