import {
  coreMigrations,
  insertReturningId,
  migrateToLatest,
  toIsoTimestamp,
  transactionWithRetry,
  writeAuthDate,
  type CoreDatabase,
} from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import type { Kysely } from 'kysely'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { DomainError } from '../errors.ts'
import { adjustScore, type ScoreAdjustment } from './adjust.ts'

const now = toIsoTimestamp(new Date('2040-03-31T12:00:00.000Z'))
let database: TestDatabase<CoreDatabase>
let db: Kysely<CoreDatabase>
let uid: number
beforeAll(async () => {
  database = await createTestDatabase<CoreDatabase>()
  db = database.db
  await migrateToLatest(db, coreMigrations)
})
afterAll(async () => database?.cleanup())
beforeEach(async () => {
  await db.deleteFrom('users').execute()
  uid = await insertReturningId(db, 'users', {
    nickname: '积分测试',
    email: 'score@example.test',
    email_verified: true,
    created_at: writeAuthDate(db, now),
    updated_at: writeAuthDate(db, now),
  })
})
function adjustment(delta: number, overrides: Partial<ScoreAdjustment> = {}): ScoreAdjustment {
  return { uid, delta, reason: 'score.reasons.initial', now, ...overrides }
}
function adjust(delta: number, overrides: Partial<ScoreAdjustment> = {}) {
  return transactionWithRetry(db, (tx) => adjustScore(tx, adjustment(delta, overrides)))
}
async function state() {
  return {
    user: await db.selectFrom('users').select('score').where('id', '=', uid).executeTakeFirstOrThrow(),
    ledger: await db.selectFrom('score_transactions').selectAll().where('user_id', '=', uid).orderBy('id').execute(),
  }
}

test('增减积分原子写入余额和流水，流水之和等于当前余额', async () => {
  expect(await adjust(20)).toEqual({ score: 20 })
  expect(await adjust(-7, { reason: 'score.reasons.texture', subject: { type: 'texture', id: 12345 } })).toEqual({
    score: 13,
  })
  expect(await adjust(2, { subject: null })).toEqual({ score: 15 })
  const { user, ledger } = await state()
  expect(
    ledger.map(({ id, ...row }) => {
      expect(id).toBeGreaterThan(0)
      return row
    }),
  ).toEqual([
    {
      user_id: uid,
      delta: 20,
      balance: 20,
      reason: 'score.reasons.initial',
      subject_type: null,
      subject_id: null,
      created_at: now,
    },
    {
      user_id: uid,
      delta: -7,
      balance: 13,
      reason: 'score.reasons.texture',
      subject_type: 'texture',
      subject_id: 12345,
      created_at: now,
    },
    {
      user_id: uid,
      delta: 2,
      balance: 15,
      reason: 'score.reasons.initial',
      subject_type: null,
      subject_id: null,
      created_at: now,
    },
  ])
  expect(ledger.reduce((sum, row) => sum + row.delta, 0)).toBe(user.score)
})

test('余额不足带领域错误参数，积分和流水都不变', async () => {
  await adjust(5)
  const before = await state()
  await expect(adjust(-6)).rejects.toMatchObject(new DomainError('score_insufficient', { required: 6, balance: 5 }))
  expect(await state()).toEqual(before)
  expect(await adjust(-5)).toEqual({ score: 0 })
})

test('上限余额可以写入，再增加时抛 RangeError 且状态不变', async () => {
  expect(await adjust(2147483647)).toEqual({ score: 2147483647 })
  const before = await state()
  await expect(adjust(1)).rejects.toThrow(RangeError)
  expect(await state()).toEqual(before)
})

test('超过 int32 的安全整数仍按余额条件报错，不触发方言溢出', async () => {
  for (const delta of [2147483648, Number.MAX_SAFE_INTEGER]) {
    await expect(adjust(delta)).rejects.toThrow(RangeError)
    await expect(adjust(-delta)).rejects.toMatchObject({
      code: 'score_insufficient',
      params: { required: delta, balance: 0 },
    })
  }
  expect(await state()).toEqual({ user: { score: 0 }, ledger: [] })
})

test('不在事务中调用抛 TypeError', async () => {
  await expect(adjustScore(db, adjustment(1))).rejects.toThrow(TypeError)
  expect(await state()).toEqual({ user: { score: 0 }, ledger: [] })
})

test.each([0, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
  '非法变动 %s 抛 RangeError',
  async (delta) => {
    await expect(adjust(delta)).rejects.toThrow(RangeError)
    expect(await state()).toEqual({ user: { score: 0 }, ledger: [] })
  },
)

test.each(['', 'a'.repeat(129)])('非法积分原因长度 %s 抛 RangeError', async (reason) => {
  await expect(adjust(1, { reason })).rejects.toThrow(RangeError)
  expect(await state()).toEqual({ user: { score: 0 }, ledger: [] })
})

test('积分原因允许 128 个码位', async () => {
  expect(await adjust(1, { reason: '😀'.repeat(128) })).toEqual({ score: 1 })
})

test.each([1, -1])('用户不存在时抛普通 Error：delta=%s', async (delta) => {
  try {
    await adjust(delta, { uid: 2147483647 })
    expect.unreachable('不存在的用户应报错')
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(DomainError)
    expect(error).not.toBeInstanceOf(RangeError)
  }
})

test('业务失败时积分和流水一起回滚', async () => {
  await expect(
    transactionWithRetry(db, async (tx) => {
      await adjustScore(tx, adjustment(10))
      throw new Error('业务回滚')
    }),
  ).rejects.toThrow('业务回滚')
  expect(await state()).toEqual({ user: { score: 0 }, ledger: [] })
})

test('流水插入失败时原子更新也随事务回滚', async () => {
  await expect(adjust(1, { now: '无效时间' as typeof now })).rejects.toThrow()
  expect(await state()).toEqual({ user: { score: 0 }, ledger: [] })
})

test('并发扣减不会透支，成功次数与实际扣减和流水条数一致', async () => {
  await adjust(10)
  const results = await Promise.all(
    Array.from({ length: 6 }, async () => {
      try {
        await adjust(-3)
        return true
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'score_insufficient') throw error
        return false
      }
    }),
  )
  const successes = results.filter(Boolean).length
  const { user, ledger } = await state()
  expect(successes).toBe(3)
  expect(user.score).toBeGreaterThanOrEqual(0)
  expect(10 - user.score).toBe(successes * 3)
  expect(ledger.filter((row) => row.delta < 0)).toHaveLength(successes)
  expect(ledger).toHaveLength(successes + 1)
  expect(ledger.reduce((sum, row) => sum + row.delta, 0)).toBe(user.score)
})
