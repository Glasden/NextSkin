import type { Generated, Kysely } from 'kysely'
import { expectTypeOf, test } from 'vitest'
import { countRows, insertOrIgnore, insertReturningId, syncAutoIncrement, upsert } from './index.ts'

interface Schema {
  items: { id: Generated<number>; name: string; n: number }
}

// 只做编译期类型检查，不执行这些写入。
function typeContract(db: Kysely<Schema>) {
  expectTypeOf(insertReturningId(db, 'items', { name: 'x', n: 1 })).toEqualTypeOf<Promise<number>>()
  expectTypeOf(insertOrIgnore(db, 'items', { name: 'x', n: 1 }, ['name'])).toEqualTypeOf<Promise<boolean>>()
  expectTypeOf(countRows(db.selectFrom('items'))).toEqualTypeOf<Promise<number>>()
  void upsert(db, 'items', {
    values: { name: 'x', n: 1 },
    conflict: ['name'],
    update: (eb) => ({ n: eb('items.n', '+', 1) }),
  })
  // @ts-expect-error 表不存在
  void insertReturningId(db, 'missing', { name: 'x', n: 1 })
  // @ts-expect-error 缺少必填列
  void insertReturningId(db, 'items', { name: 'x' })
  // @ts-expect-error 值类型错误
  void insertReturningId(db, 'items', { name: 1, n: 1 })
  // @ts-expect-error ID 列必须是数字类型
  void insertReturningId(db, 'items', { name: 'x', n: 1 }, 'name')
  // @ts-expect-error 冲突列不存在
  void insertOrIgnore(db, 'items', { name: 'x', n: 1 }, ['missing'])
  // @ts-expect-error 更新列不存在
  void upsert(db, 'items', { values: { name: 'x', n: 1 }, conflict: ['name'], update: ['missing'] })
  // @ts-expect-error 更新值类型错误
  void upsert(db, 'items', { values: { name: 'x', n: 1 }, conflict: ['name'], update: { n: 'bad' } })
  // @ts-expect-error 自增列必须存在且为数字类型
  void syncAutoIncrement(db, 'items', 'name')
}

test('公开辅助函数保留表名、列名和值类型约束', () => {
  expectTypeOf(typeContract).parameter(0).toEqualTypeOf<Kysely<Schema>>()
})
