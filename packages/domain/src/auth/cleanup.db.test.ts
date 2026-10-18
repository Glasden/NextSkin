import {
  coreMigrations,
  insertReturningId,
  migrateToLatest,
  toIsoTimestamp,
  writeAuthDate,
  type CoreDatabase,
} from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createAuthCleanup } from './cleanup.ts'

let database: TestDatabase<CoreDatabase>
let uid: number, pid: number
const db = () => database.db
const clock = new Date('2030-01-10T00:00:00Z')
const iso = (days: number) => toIsoTimestamp(new Date(clock.getTime() + days * 86_400_000))
const date = (days: number) => writeAuthDate(db(), iso(days))
const run = (signal = new AbortController().signal) =>
  createAuthCleanup({ db: db(), now: () => clock }).run({ jobId: 0, payload: {}, attempt: 1, signal })

beforeAll(async () => {
  database = await createTestDatabase<CoreDatabase>()
  await migrateToLatest(db(), coreMigrations)
  uid = await insertReturningId(db(), 'users', {
    nickname: 'test',
    email: 'test@example.test',
    email_verified: false,
    created_at: date(-30),
    updated_at: date(-30),
  })
  pid = await insertReturningId(db(), 'players', {
    user_id: uid,
    name: 'test',
    name_key: 'test',
    uuid: 'a'.repeat(32),
    created_at: iso(-30),
    updated_at: iso(-30),
  })
  await db().insertInto('oauth_clients').values({ client_id: 'cleanup', redirect_uris: '[]' }).execute()
})
afterAll(async () => database?.cleanup())
beforeEach(async () => {
  for (const table of [
    'oauth_access_tokens',
    'oauth_refresh_tokens',
    'sessions',
    'oauth_client_assertions',
    'device_codes',
    'device_code_selections',
  ] as const)
    await db().deleteFrom(table).execute()
})

test('只删除过期超过一天的认证行，刚过期、截止时刻和已撤销未过期的刷新令牌都保留', async () => {
  for (const [index, days] of [-2, -1, -0.5, 1].entries()) {
    const token = `token-${index}`
    const sessionId = await insertReturningId(db(), 'sessions', {
      token,
      user_id: uid,
      expires_at: date(days),
      created_at: date(-30),
      updated_at: date(-30),
    })
    const refreshId = await insertReturningId(db(), 'oauth_refresh_tokens', {
      token,
      client_id: 'cleanup',
      user_id: uid,
      session_id: sessionId,
      expires_at: date(days),
      created_at: date(-30),
      revoked: date(-3),
      scopes: '[]',
    })
    await db()
      .insertInto('oauth_access_tokens')
      .values({
        token,
        client_id: 'cleanup',
        user_id: uid,
        refresh_id: refreshId,
        session_id: sessionId,
        expires_at: date(days),
        created_at: date(-30),
        scopes: '[]',
      })
      .execute()
    await db()
      .insertInto('oauth_client_assertions')
      .values({ expires_at: date(days) })
      .execute()
    await db()
      .insertInto('device_codes')
      .values({ device_code: token, user_code: token, expires_at: date(days), status: 'pending' })
      .execute()
  }
  await run()
  for (const table of [
    'oauth_access_tokens',
    'oauth_refresh_tokens',
    'sessions',
    'oauth_client_assertions',
    'device_codes',
  ] as const) {
    expect(await db().selectFrom(table).select('id').execute()).toHaveLength(3)
  }
  expect(
    await db().selectFrom('oauth_refresh_tokens').select('token').where('token', '=', 'token-3').execute(),
  ).toHaveLength(1)
})

test('选择记录只删除超过一天且对应设备码已不存在的记录', async () => {
  await db()
    .insertInto('device_codes')
    .values({ device_code: 'live', user_code: 'live', expires_at: date(1), status: 'pending' })
    .execute()
  await db()
    .insertInto('device_codes')
    .values({ device_code: 'expired', user_code: 'expired', expires_at: date(-2), status: 'pending' })
    .execute()
  await db()
    .insertInto('device_code_selections')
    .values([
      { device_code: 'live', user_id: uid, player_id: pid, created_at: iso(-2) },
      { device_code: 'expired', user_id: uid, player_id: pid, created_at: iso(-2) },
      { device_code: 'orphan', user_id: uid, player_id: pid, created_at: iso(-2) },
      { device_code: 'new', user_id: uid, player_id: pid, created_at: iso(-0.5) },
      { device_code: 'boundary', user_id: uid, player_id: pid, created_at: iso(-1) },
    ])
    .execute()
  await run()
  expect(
    (await db().selectFrom('device_code_selections').select('device_code').orderBy('device_code').execute()).map(
      (row) => row.device_code,
    ),
  ).toEqual(['boundary', 'live', 'new'])
})

test('超过一千行分批清干净，取消后不继续删除', async () => {
  for (let offset = 0; offset < 1100; offset += 100) {
    await db()
      .insertInto('oauth_client_assertions')
      .values(Array.from({ length: 100 }, () => ({ expires_at: date(-2) })))
      .execute()
    await db()
      .insertInto('device_code_selections')
      .values(
        Array.from({ length: 100 }, (_, i) => ({
          device_code: `orphan-${offset + i}`,
          user_id: uid,
          player_id: pid,
          created_at: iso(-2),
        })),
      )
      .execute()
  }
  const controller = new AbortController()
  controller.abort()
  await expect(run(controller.signal)).rejects.toThrow()
  expect(await db().selectFrom('oauth_client_assertions').select('id').execute()).toHaveLength(1100)
  await run()
  expect(await db().selectFrom('oauth_client_assertions').select('id').execute()).toEqual([])
  expect(await db().selectFrom('device_code_selections').selectAll().execute()).toEqual([])
})

test('过期刷新令牌仍有未清理的访问令牌引用时两行保留，访问令牌清理后才删刷新令牌', async () => {
  for (const [index, expires] of [1, -0.5, -1, -2].entries()) {
    const refreshId = await insertReturningId(db(), 'oauth_refresh_tokens', {
      token: `refresh-${index}`,
      client_id: 'cleanup',
      user_id: uid,
      expires_at: date(-2),
      created_at: date(-30),
      scopes: '[]',
    })
    await db()
      .insertInto('oauth_access_tokens')
      .values({
        token: `access-${index}`,
        client_id: 'cleanup',
        user_id: uid,
        refresh_id: refreshId,
        expires_at: date(expires),
        created_at: date(-30),
        scopes: '[]',
      })
      .execute()
  }
  await run()
  expect(
    (await db().selectFrom('oauth_refresh_tokens').select('token').orderBy('id').execute()).map((row) => row.token),
  ).toEqual(['refresh-0', 'refresh-1', 'refresh-2'])
  expect(
    (await db().selectFrom('oauth_access_tokens').select('token').orderBy('id').execute()).map((row) => row.token),
  ).toEqual(['access-0', 'access-1', 'access-2'])
})
