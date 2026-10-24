import { toIsoTimestamp, writeAuthDate, transactionWithRetry } from '@nextskin/db'
import { captureLogs } from '@nextskin/logging'
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { deleteClaimedDeviceCodes, deleteOAuthTokensForUser, deletePlayerAuthorizations } from './revoke.ts'
import { oauthFixture, seedOAuth } from './oauth.test-helper.ts'
import { Browser, ROOT } from '../auth/security.test-helper.ts'
import { hashPassword } from 'better-auth/crypto'
import { markSiteInitialized } from '../setup/initialized.test-helper.ts'

let env: Awaited<ReturnType<typeof oauthFixture>>
let uid: number, other: number, pid: number
const password = 'correct horse battery staple'
const fresh = 'new correct horse battery staple'
beforeAll(async () => {
  env = await oauthFixture()
  await markSiteInitialized(env.db)
})
afterAll(async () => env?.cleanup())
beforeEach(async () => {
  await env.clear()
  uid = await env.user('owner')
  other = await env.user('other')
  pid = await env.player(uid, 'Steve')
})

test('按用户删令牌先计访问和刷新两行，同意保留；设备码只删认领且未兑换的，旁观者不变', async () => {
  await seedOAuth(env.db, uid, pid)
  await seedOAuth(env.db, other)
  await env.device({ uid, status: 'denied' })
  await transactionWithRetry(env.db, async (tx) => {
    expect(await deleteOAuthTokensForUser(tx, uid)).toBe(2)
    await deleteClaimedDeviceCodes(tx, uid)
  })
  for (const table of ['oauth_access_tokens', 'oauth_refresh_tokens'] as const)
    expect(await env.db.selectFrom(table).select('user_id').execute()).toEqual([{ user_id: other }])
  expect(await env.db.selectFrom('oauth_consents').selectAll().execute()).toHaveLength(2)
  expect(
    await env.db.selectFrom('device_codes').selectAll().where('user_id', '=', String(uid)).execute(),
  ).toMatchObject([{ status: 'denied' }])
  expect(await env.db.selectFrom('device_code_selections').selectAll().execute()).toEqual([])
})

test('按角色删授权只删绑定该角色的行；事务失败全部回滚；拒绝非事务调用', async () => {
  await seedOAuth(env.db, uid, pid)
  await seedOAuth(env.db, uid)
  await expect(deletePlayerAuthorizations(env.db, pid)).rejects.toThrow(TypeError)
  await expect(
    transactionWithRetry(env.db, async (tx) => {
      await deletePlayerAuthorizations(tx, pid)
      throw new Error('rollback')
    }),
  ).rejects.toThrow('rollback')
  expect(await env.db.selectFrom('oauth_access_tokens').selectAll().execute()).toHaveLength(2)
  await transactionWithRetry(env.db, (tx) => deletePlayerAuthorizations(tx, pid))
  for (const table of ['oauth_access_tokens', 'oauth_refresh_tokens', 'oauth_consents'] as const)
    expect(await env.db.selectFrom(table).select('reference_id').execute()).toEqual([{ reference_id: null }])
})

test.each(['change-password', 'reset-password', 'setPassword'] as const)(
  '%s 删除 OAuth 令牌和认领设备码，同意及旁观者保留',
  async (method) => {
    await env.db
      .insertInto('accounts')
      .values({
        user_id: uid,
        provider_id: 'credential',
        account_id: String(uid),
        password: await hashPassword(password),
        created_at: writeAuthDate(env.db, toIsoTimestamp(env.now())),
        updated_at: writeAuthDate(env.db, toIsoTimestamp(env.now())),
      })
      .execute()
    const owner = new Browser(env.core)
    expect((await owner.request('/api/auth/sign-in/email', { email: 'owner@example.test', password })).status).toBe(200)
    await seedOAuth(env.db, uid, pid)
    await seedOAuth(env.db, other)
    if (method === 'change-password') {
      expect(
        (await owner.request('/api/auth/change-password', { currentPassword: password, newPassword: fresh })).status,
      ).toBe(200)
    } else if (method === 'setPassword') {
      await env.db.deleteFrom('accounts').where('user_id', '=', uid).execute()
      await env.core.auth.setPassword({
        uid,
        password: fresh,
        headers: new Headers({ cookie: owner.cookieHeader() }),
        requestRoot: ROOT,
      })
    } else {
      await env.db
        .insertInto('settings')
        .values([
          {
            namespace: 'core',
            key: 'mail.transport',
            value: JSON.stringify('smtp'),
            updated_at: toIsoTimestamp(env.now()),
          },
          {
            namespace: 'core',
            key: 'mail.from',
            value: JSON.stringify({ address: 'skin@example.test', name: 'NextSkin' }),
            updated_at: toIsoTimestamp(env.now()),
          },
        ])
        .execute()
      const response = await owner.request('/api/auth/request-password-reset', {
        email: 'owner@example.test',
        redirectTo: `${ROOT}/reset-password`,
      })
      expect(response.status).toBe(200)
      const row = await env.db
        .selectFrom('verifications')
        .select('identifier')
        .where('value', '=', String(uid))
        .where('identifier', 'like', 'reset-password:%')
        .executeTakeFirstOrThrow()
      const token = row.identifier.slice('reset-password:'.length)
      expect((await owner.request('/api/auth/reset-password', { token, newPassword: fresh })).status).toBe(200)
    }
    for (const table of ['oauth_access_tokens', 'oauth_refresh_tokens'] as const)
      expect(await env.db.selectFrom(table).select('user_id').execute()).toEqual([{ user_id: other }])
    expect(await env.db.selectFrom('device_codes').selectAll().where('user_id', '=', String(uid)).execute()).toEqual([])
    expect(await env.db.selectFrom('device_code_selections').selectAll().where('user_id', '=', uid).execute()).toEqual(
      [],
    )
    expect(await env.db.selectFrom('oauth_consents').selectAll().execute()).toHaveLength(2)
  },
)

test('密码变更事件入队失败，凭据吊销仍已单独提交', async () => {
  await env.db
    .insertInto('accounts')
    .values({
      user_id: uid,
      provider_id: 'credential',
      account_id: String(uid),
      password: await hashPassword(password),
      created_at: writeAuthDate(env.db, toIsoTimestamp(env.now())),
      updated_at: writeAuthDate(env.db, toIsoTimestamp(env.now())),
    })
    .execute()
  const owner = new Browser(env.core)
  expect((await owner.request('/api/auth/sign-in/email', { email: 'owner@example.test', password })).status).toBe(200)
  await seedOAuth(env.db, uid, pid)
  env.core.events.subscribe('user.profileUpdated', 'test:password', { run: async () => {} })
  const enqueue = env.core.jobs.enqueue.bind(env.core.jobs)
  const spy = vi.spyOn(env.core.jobs, 'enqueue').mockImplementation((tx, name, ...rest) => {
    if (name === 'test:password') return Promise.reject(new Error('queue unavailable'))
    return enqueue(tx, name, ...rest)
  })
  const warn = captureLogs()
  try {
    expect(
      (await owner.request('/api/auth/change-password', { currentPassword: password, newPassword: fresh })).status,
    ).toBe(200)
    expect(warn.records).toContainEqual(
      expect.objectContaining({ area: 'auth', level: 'warn', msg: 'password_event_failed' }),
    )
  } finally {
    spy.mockRestore()
    warn.restore()
  }
  for (const table of ['oauth_access_tokens', 'oauth_refresh_tokens', 'device_code_selections'] as const)
    expect(await env.db.selectFrom(table).selectAll().where('user_id', '=', uid).execute()).toEqual([])
  expect(await env.db.selectFrom('device_codes').selectAll().where('user_id', '=', String(uid)).execute()).toEqual([])
})
