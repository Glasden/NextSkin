import { sql, type Kysely } from 'kysely'
import type { Migration } from 'kysely/migration'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { autoIncrementId, countRows, createTable, migrateToLatest } from './index.ts'
import { createTestDatabase, testDialect, type TestDatabase } from './testing.ts'
interface Schema {
  records: { id: number; n: number }
  items: { n: number }
}
let database: TestDatabase<Schema>
let db: Kysely<Schema>
beforeEach(async () => {
  database = await createTestDatabase<Schema>()
  db = database.db
  await createTable(db, 'items')
    .addColumn('n', 'integer', (c) => c.unique())
    .execute()
  await db.insertInto('items').values({ n: 1 }).execute()
})
afterEach(async () => {
  await database?.cleanup()
})

test('迁移按字典序执行，重复运行时不再执行迁移', async () => {
  const { db } = database
  const migrations: Record<string, Migration> = {
    '0002_seed': {
      up: async (trx) => {
        await trx
          .withTables<{ records: { id: number; n: number } }>()
          .insertInto('records')
          .values({ id: 1, n: 3 })
          .execute()
      },
    },
    '0001_create': {
      up: async (trx) => {
        await createTable(trx, 'records')
          .$call(autoIncrementId(trx))
          .addColumn('n', 'integer', (c) => c.notNull())
          .execute()
      },
    },
  }
  expect(await migrateToLatest(db, migrations)).toEqual(['0001_create', '0002_seed'])
  expect(await migrateToLatest(db, migrations)).toEqual([])
  expect(await countRows(db.selectFrom('records'))).toBe(1)
  expect(await db.introspection.getTables()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'nextskin_migration' }),
      expect.objectContaining({ name: 'nextskin_migration_lock' }),
    ]),
  )
})

test('全新的库没有已执行的迁移，不调用升级前回调', async () => {
  const beforeUpgrade = vi.fn(async () => {})
  const migrations = { '0001_initial': { up: async () => {} } }
  expect((await db.introspection.getTables()).map((table) => table.name)).not.toContain('nextskin_migration')
  expect(await migrateToLatest(db, migrations, { beforeUpgrade })).toEqual(['0001_initial'])
  expect(beforeUpgrade).not.toHaveBeenCalled()
})

test('没有要执行的迁移时不调用升级前回调', async () => {
  const migrations = { '0001_initial': { up: async () => {} } }
  await migrateToLatest(db, migrations)
  const beforeUpgrade = vi.fn(async () => {})
  expect(await migrateToLatest(db, migrations, { beforeUpgrade })).toEqual([])
  expect(beforeUpgrade).not.toHaveBeenCalled()
})

test('已有迁移时按字典序把未执行的名字传给升级前回调一次', async () => {
  const initial = { '0001_initial': { up: async () => {} } }
  const options = { migrationTableName: 'upgrade_migration', migrationLockTableName: 'upgrade_lock' }
  await migrateToLatest(db, initial, options)
  const second = vi.fn(async () => {})
  const third = vi.fn(async () => {})
  const beforeUpgrade = vi.fn((pending: string[]) => {
    expect(pending).toEqual(['0002_second', '0003_third'])
    expect(second).not.toHaveBeenCalled()
    expect(third).not.toHaveBeenCalled()
    return Promise.resolve()
  })
  expect(
    await migrateToLatest(
      db,
      { '0003_third': { up: third }, ...initial, '0002_second': { up: second } },
      { ...options, beforeUpgrade },
    ),
  ).toEqual(['0002_second', '0003_third'])
  expect(beforeUpgrade).toHaveBeenCalledExactlyOnceWith(['0002_second', '0003_third'])
})

test('升级前回调抛错时原样抛出，不执行新迁移，之后可以重试', async () => {
  const initial = { '0001_initial': { up: async () => {} } }
  await migrateToLatest(db, initial)
  const failure = new Error('备份失败')
  const upgrade = vi.fn(async (trx: Kysely<unknown>) => {
    await sql`insert into items values (2)`.execute(trx)
  })
  const migrations = { ...initial, '0002_upgrade': { up: upgrade } }
  await expect(migrateToLatest(db, migrations, { beforeUpgrade: () => Promise.reject(failure) })).rejects.toBe(failure)
  expect(upgrade).not.toHaveBeenCalled()
  expect(await db.selectFrom('items').selectAll().execute()).toEqual([{ n: 1 }])
  expect(await migrateToLatest(db, migrations)).toEqual(['0002_upgrade'])
  expect(await db.selectFrom('items').selectAll().orderBy('n').execute()).toEqual([{ n: 1 }, { n: 2 }])
})

test('迁移失败时报告迁移名并保留原因，不标记为已执行', async () => {
  const failure = new Error('主动触发的迁移错误')
  const migrations: Record<string, Migration> = {
    '0001_failure': { up: () => Promise.reject(failure) },
  }
  const options = { migrationTableName: 'failure_migration', migrationLockTableName: 'failure_lock' }
  const migration = migrateToLatest(database.db, migrations, options)
  await expect(migration).rejects.toThrow('迁移 0001_failure 执行失败')
  await expect(migration).rejects.toMatchObject({ cause: failure })
  const fixed: Record<string, Migration> = { '0001_failure': { up: () => Promise.resolve() } }
  expect(await migrateToLatest(database.db, fixed, options)).toEqual(['0001_failure'])
  expect(await migrateToLatest(database.db, fixed, options)).toEqual([])
})

test('并发迁移只执行一次', async () => {
  let executions = 0
  const migrations = {
    '0001_once': {
      up: async (trx: Kysely<unknown>) => {
        executions++
        await sql`insert into items values (2)`.execute(trx)
      },
    },
  }
  const results = await Promise.all([migrateToLatest(db, migrations), migrateToLatest(db, migrations)])
  expect(executions).toBe(1)
  expect(results.flat()).toEqual(['0001_once'])
})

// MySQL/MariaDB 的 DDL 不受事务保护，只有 SQLite/PG 检查 DDL 回滚。
test.skipIf(testDialect() === 'mysql' || testDialect() === 'mariadb')('迁移失败时回滚 DDL 和数据', async () => {
  await expect(
    migrateToLatest(db, {
      '0001_partial': {
        up: async (trx) => {
          await trx.schema.createTable('partial').addColumn('n', 'integer').execute()
          await sql`insert into items values (2)`.execute(trx)
          throw new Error('迁移中途失败')
        },
      },
    }),
  ).rejects.toThrow('0001_partial')
  expect((await db.introspection.getTables()).map((table) => table.name)).not.toContain('partial')
  expect(await db.selectFrom('items').selectAll().execute()).toEqual([{ n: 1 }])
})
