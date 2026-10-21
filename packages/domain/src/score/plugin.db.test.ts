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
import type { Kysely, KyselyPlugin, QueryId } from 'kysely'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { PluginCallRejected } from '../plugins/errors.ts'
import { adjustScore } from './adjust.ts'
import { adjustPluginScore, type PluginScoreAdjustment } from './plugin.ts'

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
    email: 'plugin-score@example.test',
    email_verified: true,
    created_at: writeAuthDate(db, now),
    updated_at: writeAuthDate(db, now),
  })
})
const adjust = (delta: number, overrides: Partial<PluginScoreAdjustment> = {}) =>
  adjustPluginScore(db, { pluginId: 'reward', key: 'once', uid, delta, reason: 'score.reward', now, ...overrides })
const ledger = () => db.selectFrom('score_transactions').selectAll().orderBy('id').execute()
const balance = async () =>
  (await db.selectFrom('users').select('score').where('id', '=', uid).executeTakeFirstOrThrow()).score

test('applied 写对插件与键，正负流水之和等于余额，不写审计或事件', async () => {
  expect(await adjust(20)).toEqual({ status: 'applied', balance: 20 })
  expect(await adjust(-7, { key: 'deduct' })).toEqual({ status: 'applied', balance: 13 })
  expect(await ledger()).toEqual([
    {
      id: expect.any(Number) as unknown,
      user_id: uid,
      delta: 20,
      balance: 20,
      reason: 'score.reward',
      plugin_id: 'reward',
      plugin_key: 'once',
      subject_type: null,
      subject_id: null,
      created_at: now,
    },
    {
      id: expect.any(Number) as unknown,
      user_id: uid,
      delta: -7,
      balance: 13,
      reason: 'score.reward',
      plugin_id: 'reward',
      plugin_key: 'deduct',
      subject_type: null,
      subject_id: null,
      created_at: now,
    },
  ])
  expect((await ledger()).reduce((sum, row) => sum + row.delta, 0)).toBe(await balance())
  expect(await db.selectFrom('audit_logs').selectAll().execute()).toEqual([])
  expect(await db.selectFrom('jobs').selectAll().execute()).toEqual([])
})

test('duplicate 不再写流水，返回当前余额，reason 不参与去重', async () => {
  await adjust(20)
  expect(await adjust(20, { reason: 'another.reason' })).toEqual({ status: 'duplicate', balance: 20 })
  expect(await ledger()).toHaveLength(1)
  await adjust(3, { key: 'another' })
  expect(await adjust(20)).toEqual({ status: 'duplicate', balance: 23 })
  expect(await balance()).toBe(23)
})

test('同 key 不同 uid 或 delta 拒绝，不改变余额或流水', async () => {
  await adjust(20)
  const before = await ledger()
  await expect(adjust(21)).rejects.toThrow(PluginCallRejected)
  await expect(adjust(20, { uid: uid + 1 })).rejects.toThrow('同一个 key 已经用于另一笔积分变动')
  expect(await ledger()).toEqual(before)
  expect(await balance()).toBe(20)
})

test('余额不足或原本为负都返回 insufficient，什么都没写，失败不占 key', async () => {
  expect(await adjust(-1)).toEqual({ status: 'insufficient', balance: 0 })
  expect(await ledger()).toEqual([])
  expect(await adjust(1)).toEqual({ status: 'applied', balance: 1 })
  // 导入器允许负余额；模拟历史状态，随后扣减不应新增任何流水。
  await db.updateTable('users').set({ score: -10 }).where('id', '=', uid).execute()
  const before = await ledger()
  expect(await adjust(-1, { key: 'negative' })).toEqual({ status: 'insufficient', balance: -10 })
  expect(await balance()).toBe(-10)
  expect(await ledger()).toEqual(before)
})

test('用户不存在返回 userNotFound，不占用 key', async () => {
  for (const missing of [2147483647, 2147483648, Number.MAX_SAFE_INTEGER])
    expect(await adjust(10, { uid: missing })).toEqual({ status: 'userNotFound', balance: null })
  expect(await ledger()).toEqual([])
  expect(await adjust(10)).toEqual({ status: 'applied', balance: 10 })
})

test('加到上限可以，再加被拒绝并整体回滚', async () => {
  await adjust(2147483647)
  const before = await ledger()
  await expect(adjust(1, { key: 'overflow' })).rejects.toThrow(PluginCallRejected)
  expect(await ledger()).toEqual(before)
  expect(await balance()).toBe(2147483647)
})

test('并发同一个 key 只记一笔，包括不同 uid 和 delta 的冲突', async () => {
  const results = await Promise.all([adjust(10), adjust(10)])
  expect(results.map((r) => r.status).sort()).toEqual(['applied', 'duplicate'])
  expect(results.map((r) => r.balance)).toEqual([10, 10])
  expect(await ledger()).toHaveLength(1)
  expect(await balance()).toBe(10)
  const conflict = await Promise.allSettled([adjust(2, { key: 'conflict' }), adjust(3, { key: 'conflict' })])
  expect(conflict.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(conflict.filter((r) => r.status === 'rejected')).toMatchObject([{ reason: { name: 'PluginCallRejected' } }])
  expect((await ledger()).reduce((sum, row) => sum + row.delta, 0)).toBe(await balance())
})

test('不同插件的同 key 独立，不检查封禁，核心流水仍用 NULL', async () => {
  await db.updateTable('users').set({ role: 'banned' }).where('id', '=', uid).execute()
  await adjust(10)
  await adjust(20, { pluginId: 'other' })
  await transactionWithRetry(db, (tx) => adjustScore(tx, { uid, delta: 1, reason: 'core', now }))
  expect(await balance()).toBe(31)
  expect((await ledger()).map((r) => [r.plugin_id, r.plugin_key])).toEqual([
    ['reward', 'once'],
    ['other', 'once'],
    [null, null],
  ])
})

test.each(['deduct', 'upper'] as const)('同 key 并发 %s 不会误报余额不足或超过上限', async (kind) => {
  if (kind === 'deduct') await adjust(10, { key: 'initial' })
  const delta = kind === 'deduct' ? -10 : 2147483647
  const results = await Promise.all([adjust(delta), adjust(delta)])
  expect(results.map((r) => r.status).sort()).toEqual(['applied', 'duplicate'])
  expect(await balance()).toBe(kind === 'deduct' ? 0 : 2147483647)
  expect((await ledger()).filter((r) => r.plugin_key === 'once')).toHaveLength(1)
})

// 同 uuid-race.test-helper：SQLite 的事务串行，隐藏一次预查结果来确定性模拟并发提交。
function missPluginPrecheckOnce() {
  let selects = 0
  const missed = new Set<QueryId>()
  const plugin: KyselyPlugin = {
    transformQuery({ node, queryId }) {
      const text = JSON.stringify(node)
      if (node.kind === 'SelectQueryNode' && text.includes('"score_transactions"') && text.includes('"plugin_key"')) {
        if (++selects === 1) missed.add(queryId)
      }
      return node
    },
    transformResult({ result, queryId }) {
      return Promise.resolve(missed.has(queryId) ? { ...result, rows: [] } : result)
    },
  }
  return { plugin, selects: () => selects }
}

test('预查之后、改余额之前用户被并发删除：返回 userNotFound，不抛错', async () => {
  // 先删掉用户，再让事务里第一次单独查 users 的语句照样查到它，相当于删除发生在预查和改余额之间
  await db.deleteFrom('users').where('id', '=', uid).execute()
  const faked = new Set<QueryId>()
  const plugin: KyselyPlugin = {
    transformQuery({ node, queryId }) {
      const text = JSON.stringify(node)
      if (
        !faked.size &&
        node.kind === 'SelectQueryNode' &&
        text.includes('"users"') &&
        !text.includes('"score_transactions"')
      )
        faked.add(queryId)
      return node
    },
    transformResult({ result, queryId }) {
      return Promise.resolve(faked.has(queryId) ? { ...result, rows: [{ score: 0 }] } : result)
    },
  }
  expect(
    await adjustPluginScore(db.withPlugin(plugin), {
      pluginId: 'reward',
      key: 'once',
      uid,
      delta: 5,
      reason: 'score.reward',
      now,
    }),
  ).toEqual({ status: 'userNotFound', balance: null })
  expect(faked.size).toBe(1)
  expect(await ledger()).toEqual([])
})

test.each([false, true])('唯一键冲突回滚余额，在事务外判断重放，不被事务重试吞掉（参数冲突=%s）', async (conflict) => {
  await adjust(10)
  const before = await ledger()
  const miss = missPluginPrecheckOnce()
  const replay = adjustPluginScore(db.withPlugin(miss.plugin), {
    pluginId: 'reward',
    key: 'once',
    uid,
    delta: conflict ? 11 : 10,
    reason: 'score.reward',
    now,
  })
  if (conflict) await expect(replay).rejects.toThrow(PluginCallRejected)
  else expect(await replay).toEqual({ status: 'duplicate', balance: 10 })
  // 一次事务内预查，一次事务外复查；重跑事务会多查一次。
  expect(miss.selects()).toBe(2)
  expect(await ledger()).toEqual(before)
  expect(await balance()).toBe(10)
})

test.each(['deduct', 'upper'] as const)('并发 %s 先撞余额条件时，回滚后仍识别 duplicate', async (kind) => {
  const delta = kind === 'deduct' ? -10 : 2147483647
  if (kind === 'deduct') await adjust(10, { key: 'initial' })
  await adjust(delta)
  const before = await ledger()
  const miss = missPluginPrecheckOnce()
  expect(
    await adjustPluginScore(db.withPlugin(miss.plugin), {
      pluginId: 'reward',
      key: 'once',
      uid,
      delta,
      reason: 'score.reward',
      now,
    }),
  ).toEqual({ status: 'duplicate', balance: kind === 'deduct' ? 0 : 2147483647 })
  expect(miss.selects()).toBe(2)
  expect(await ledger()).toEqual(before)
})
