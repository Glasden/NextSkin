import { toIsoTimestamp, writeAuthDate } from '@nextskin/db'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { oauthFixture, seedOAuth } from './oauth.test-helper.ts'
import { OAUTH_SCOPES, playerReference, READ_SCOPE, SELECT_SCOPE } from './scopes.ts'

let env: Awaited<ReturnType<typeof oauthFixture>>
let uid: number, other: number, pid: number
beforeAll(async () => {
  env = await oauthFixture()
})
afterAll(async () => env?.cleanup())
beforeEach(async () => {
  await env.clear()
  uid = await env.user('owner')
  other = await env.user('other')
  pid = await env.player(uid, 'Steve')
})

test('合并同意和有效令牌，scope 按声明顺序，角色去重排序；停用仍列出，按最新授权倒序', async () => {
  const app = await env.client('application')
  await env.db.updateTable('oauth_clients').set({ user_id: other, disabled: true }).where('id', '=', app.id).execute()
  await seedOAuth(env.db, uid, pid, app.clientId)
  const secondPid = await env.player(uid, 'Alex')
  await env.db
    .updateTable('oauth_refresh_tokens')
    .set({ reference_id: playerReference(secondPid), scopes: JSON.stringify(['email', 'openid', READ_SCOPE]) })
    .where('user_id', '=', uid)
    .execute()
  const recent = toIsoTimestamp(new Date('2029-12-31T00:00:00Z'))
  await env.db
    .updateTable('oauth_consents')
    .set({ scopes: JSON.stringify(['profile', SELECT_SCOPE]), updated_at: writeAuthDate(env.db, recent) })
    .where('user_id', '=', uid)
    .execute()
  await seedOAuth(env.db, uid, pid)
  const result = await env.core.oauth.listAuthorizations(uid)
  expect(result).toHaveLength(2)
  expect(result[0]).toEqual({
    id: app.id,
    client: {
      id: app.id,
      clientId: app.clientId,
      name: 'application',
      shared: false,
      owner: { uid: other, nickname: 'other' },
    },
    scopes: OAUTH_SCOPES.filter((scope) => ['openid', 'profile', 'email', SELECT_SCOPE, READ_SCOPE].includes(scope)),
    players: [
      { pid, name: 'Steve' },
      { pid: secondPid, name: 'Alex' },
    ].sort((a, b) => a.pid - b.pid),
    authorizedAt: recent,
  })
  expect(result[1]).toMatchObject({
    client: { clientId: 'shared', shared: true, owner: null, name: null },
    players: [{ pid, name: 'Steve' }],
  })
  const newest = toIsoTimestamp(env.now())
  await env.db
    .updateTable('oauth_access_tokens')
    .set({ created_at: writeAuthDate(env.db, newest) })
    .where('client_id', '=', 'shared')
    .execute()
  expect((await env.core.oauth.listAuthorizations(uid))[0]).toMatchObject({
    client: { clientId: 'shared' },
    authorizedAt: newest,
  })
})

test('设备流程没有同意也列出；过期、已吊销令牌不贡献权限、角色、时间，已转让角色不列出', async () => {
  const app = await env.client('tokens-only')
  await seedOAuth(env.db, uid, pid, app.clientId)
  await env.db.deleteFrom('oauth_consents').execute()
  await env.db.updateTable('players').set({ user_id: other }).where('id', '=', pid).execute()
  expect(await env.core.oauth.listAuthorizations(uid)).toMatchObject([
    { players: [], scopes: ['openid', SELECT_SCOPE] },
  ])
  await env.db
    .updateTable('oauth_access_tokens')
    .set({ expires_at: writeAuthDate(env.db, toIsoTimestamp(env.now())) })
    .execute()
  await env.db
    .updateTable('oauth_refresh_tokens')
    .set({ revoked: writeAuthDate(env.db, toIsoTimestamp(env.now())) })
    .execute()
  expect(await env.core.oauth.listAuthorizations(uid)).toEqual([])
  await env.db
    .updateTable('oauth_access_tokens')
    .set({
      expires_at: writeAuthDate(env.db, toIsoTimestamp(new Date('2040-01-01T00:00:00Z'))),
      revoked: writeAuthDate(env.db, toIsoTimestamp(env.now())),
    })
    .execute()
  await env.db
    .updateTable('oauth_refresh_tokens')
    .set({ revoked: null, expires_at: writeAuthDate(env.db, toIsoTimestamp(env.now())) })
    .execute()
  expect(await env.core.oauth.listAuthorizations(uid)).toEqual([])
})

test('取消授权删除本应用的令牌、同意、待批准和已批准设备码及选择，其他应用和用户保留，幂等', async () => {
  const app = await env.client('target')
  const otherPid = await env.player(other, 'Other')
  await seedOAuth(env.db, uid, pid, app.clientId)
  await seedOAuth(env.db, uid, pid)
  await seedOAuth(env.db, other, otherPid, app.clientId)
  await env.core.oauth.revokeAuthorization(uid, app.id)
  await env.core.oauth.revokeAuthorization(uid, app.id)
  await env.core.oauth.revokeAuthorization(uid, 999999)
  await env.core.oauth.revokeAuthorization(999999, app.id)
  for (const table of ['oauth_access_tokens', 'oauth_refresh_tokens', 'oauth_consents'] as const) {
    const rows = await env.db.selectFrom(table).select(['client_id', 'user_id']).execute()
    expect(rows).toHaveLength(2)
    expect(rows).toEqual(
      expect.arrayContaining([
        { user_id: uid, client_id: 'shared' },
        { user_id: other, client_id: app.clientId },
      ]),
    )
  }
  expect(await env.db.selectFrom('device_codes').selectAll().execute()).toHaveLength(4)
  expect(await env.db.selectFrom('device_code_selections').selectAll().execute()).toHaveLength(4)
  expect(
    await env.db
      .selectFrom('device_codes')
      .selectAll()
      .where('user_id', '=', String(uid))
      .where('client_id', '=', app.clientId)
      .execute(),
  ).toEqual([])
})
