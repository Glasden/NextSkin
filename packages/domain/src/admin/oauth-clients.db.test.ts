import { countRows, readAuthBoolean, toIsoTimestamp, writeAuthDate, type UserRole } from '@nextskin/db'
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { pauseNextCommit } from '../commit-pause.test-helper.ts'
import { can } from '../access/permissions.ts'
import { MAIL_JOB } from '../mail/service.ts'
import { readClient } from '../oauth/devices.ts'
import { oauthFixture, seedOAuth } from '../oauth/oauth.test-helper.ts'
import type { AdminActor } from './types.ts'

vi.mock('../access/permissions.ts', { spy: true })
const permissions = await vi.importActual<typeof import('../access/permissions.ts')>('../access/permissions.ts')
let env: Awaited<ReturnType<typeof oauthFixture>>
let uid: number, admin: AdminActor, superadmin: AdminActor
beforeAll(async () => {
  env = await oauthFixture()
})
afterAll(async () => env?.cleanup())
beforeEach(async () => {
  vi.mocked(can).mockImplementation(permissions.can)
  await env.clear()
  await env.db.deleteFrom('audit_logs').execute()
  await env.db.deleteFrom('jobs').execute()
  uid = await env.user('owner')
  admin = { uid: await env.user('admin'), ip: '192.0.2.1' }
  superadmin = { uid: await env.user('superadmin'), ip: '192.0.2.2' }
  await role(admin.uid, 'admin')
  await role(superadmin.uid, 'superadmin')
})
const role = (id: number, role: UserRole) => env.db.updateTable('users').set({ role }).where('id', '=', id).execute()
async function client(owner: number | null = uid, name: string | null = 'Application') {
  const result = await env.core.oauth.createClient(
    { uid },
    { name: name ?? 'temporary', type: 'native', redirectUris: [] },
  )
  await env.db.updateTable('oauth_clients').set({ user_id: owner, name }).where('id', '=', result.client.id).execute()
  return result.client
}
async function configureMail() {
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
        value: JSON.stringify({ address: 'sender@example.test', name: 'NextSkin' }),
        updated_at: toIsoTimestamp(env.now()),
      },
    ])
    .execute()
}
async function logs() {
  return (await env.db.selectFrom('audit_logs').selectAll().orderBy('id').execute()).map((entry) => ({
    ...entry,
    details: JSON.parse(entry.details) as Record<string, unknown>,
  }))
}
async function notices() {
  return (await env.db.selectFrom('jobs').select('payload').where('name', '=', MAIL_JOB).orderBy('id').execute()).map(
    (entry) => JSON.parse(entry.payload) as Record<string, unknown>,
  )
}
const methods = ['disableOAuthClient', 'enableOAuthClient', 'deleteOAuthClient'] as const

test('列表和写操作均要求 oauthClients.manage，按库里的身份检查', async () => {
  const app = await client()
  await expect(env.core.admin.listOAuthClients(uid, { page: 1 })).rejects.toMatchObject({ code: 'permission_denied' })
  for (const method of methods)
    await expect(env.core.admin[method]({ uid, ip: null }, app.id)).rejects.toMatchObject({ code: 'permission_denied' })
  vi.mocked(can).mockImplementation(
    (role, permission) => permission !== 'oauthClients.manage' && permissions.can(role, permission),
  )
  await expect(env.core.admin.listOAuthClients(admin.uid, { page: 1 })).rejects.toMatchObject({
    code: 'permission_denied',
  })
  for (const method of methods)
    await expect(env.core.admin[method](admin, app.id)).rejects.toMatchObject({ code: 'permission_denied' })
})

test.each(methods)('%s：按主人等级判断，自己的、其他管理员和超级管理员均受保护', async (method) => {
  const peer = await env.user('peer-admin')
  await role(peer, 'admin')
  for (const owner of [admin.uid, peer, superadmin.uid]) {
    const app = await client(owner)
    await expect(env.core.admin[method](admin, app.id)).rejects.toMatchObject({ code: 'user_not_manageable' })
  }
  const app = await client()
  if (method === 'enableOAuthClient') await env.core.admin.disableOAuthClient(admin, app.id)
  if (method === 'deleteOAuthClient') await expect(env.core.admin[method](admin, app.id)).resolves.toBeUndefined()
  else await expect(env.core.admin[method](admin, app.id)).resolves.toBeDefined()
  await expect(env.core.admin[method](admin, 2147483647)).rejects.toMatchObject({ code: 'oauth_client_not_found' })
})

test('无主人按管理员算；公用应用只有超级管理员能停用、启用，谁都删不了', async () => {
  const orphan = await client(null)
  const shared = await env.db
    .selectFrom('oauth_clients')
    .select('id')
    .where('client_id', '=', 'shared')
    .executeTakeFirstOrThrow()
  for (const app of [orphan, shared]) {
    for (const method of methods)
      await expect(env.core.admin[method](admin, app.id)).rejects.toMatchObject({ code: 'oauth_client_not_manageable' })
    expect(await env.core.admin.disableOAuthClient(superadmin, app.id)).toMatchObject({ disabled: true, owner: null })
    expect(await env.core.admin.enableOAuthClient(superadmin, app.id)).toMatchObject({ disabled: false, owner: null })
  }
  await expect(env.core.admin.deleteOAuthClient(superadmin, shared.id)).rejects.toMatchObject({
    code: 'oauth_client_shared',
  })
  await env.core.admin.deleteOAuthClient(superadmin, orphan.id)
})

test('停用/启用改 disabled，readClient 随之拒绝/恢复；幂等不写审计不通知；启用不通知', async () => {
  const app = await client()
  await configureMail()
  await seedOAuth(env.db, uid, null, app.clientId)
  const before = await env.db.selectFrom('oauth_access_tokens').selectAll().execute()
  expect(await env.core.admin.disableOAuthClient(admin, app.id)).toMatchObject({
    id: app.id,
    disabled: true,
    authorizedUsers: 1,
  })
  expect(
    readAuthBoolean(
      (await env.db.selectFrom('oauth_clients').select('disabled').where('id', '=', app.id).executeTakeFirstOrThrow())
        .disabled!,
    ),
  ).toBe(true)
  expect(await readClient(env.db, app.clientId)).toMatchObject({ disabled: true })
  expect(
    await env.core.oauth.openDevice(
      uid,
      (
        await env.db
          .selectFrom('device_codes')
          .select('user_code')
          .where('client_id', '=', app.clientId)
          .executeTakeFirstOrThrow()
      ).user_code,
    ),
  ).toEqual({ status: 'invalid' })
  await env.core.admin.disableOAuthClient(admin, app.id)
  expect(await logs()).toHaveLength(1)
  expect(await notices()).toMatchObject([
    { uid, to: 'owner@example.test', changes: [{ kind: 'oauthClientDisabled', name: 'Application' }] },
  ])
  env.advance(1000)
  expect(await env.core.admin.enableOAuthClient(admin, app.id)).toMatchObject({ disabled: false })
  await env.core.admin.enableOAuthClient(admin, app.id)
  expect(await readClient(env.db, app.clientId)).toMatchObject({ disabled: false })
  expect(await env.db.selectFrom('oauth_access_tokens').selectAll().execute()).toEqual(before)
  const audit = await logs()
  expect(audit.map((a) => a.action)).toEqual(['oauthClient.disable', 'oauthClient.enable'])
  for (const log of audit)
    expect(log).toMatchObject({
      actor_user_id: admin.uid,
      subject_type: 'oauthClient',
      subject_id: app.id,
      ip: admin.ip,
      details: { clientId: app.clientId, name: 'Application', ownerUid: uid },
    })
  expect(await notices()).toHaveLength(1)
  const listed = await env.core.admin.listAudit(admin.uid, { page: 1 })
  expect(listed.items[0]).toMatchObject({ subject: { type: 'oauthClient', id: app.id, exists: true } })
})

test('删除的审计统计去重用户和有效令牌，清理设备码和选择；删除后审计对象不存在', async () => {
  const app = await client(uid, null)
  await configureMail()
  const other = await env.user('other')
  const expired = await env.user('expired')
  const pid = await env.player(uid, 'Steve')
  await seedOAuth(env.db, uid, pid, app.clientId)
  await seedOAuth(env.db, other, null, app.clientId)
  await seedOAuth(env.db, expired, null, app.clientId)
  await seedOAuth(env.db, uid, pid)
  await env.db.deleteFrom('oauth_consents').where('user_id', '=', expired).execute()
  const at = writeAuthDate(env.db, toIsoTimestamp(env.now()))
  await env.db.updateTable('oauth_access_tokens').set({ expires_at: at }).where('user_id', '=', expired).execute()
  await env.db.updateTable('oauth_refresh_tokens').set({ revoked: at }).where('user_id', '=', other).execute()
  await env.core.admin.deleteOAuthClient(admin, app.id)
  expect(await logs()).toMatchObject([
    {
      action: 'oauthClient.delete',
      subject_type: 'oauthClient',
      subject_id: app.id,
      details: {
        clientId: app.clientId,
        name: null,
        ownerUid: uid,
        authorizedUsers: 3,
        accessTokens: 2,
        refreshTokens: 2,
      },
    },
  ])
  expect(await notices()).toMatchObject([{ uid, changes: [{ kind: 'oauthClientDeleted', name: app.clientId }] }])
  for (const table of ['oauth_access_tokens', 'oauth_refresh_tokens', 'oauth_consents', 'device_codes'] as const)
    expect(await countRows(env.db.selectFrom(table).where('client_id', '=', app.clientId))).toBe(0)
  expect(await countRows(env.db.selectFrom('device_code_selections'))).toBe(2)
  const audit = await env.core.admin.listAudit(admin.uid, { page: 1 })
  expect(audit.items[0]).toMatchObject({ subject: { type: 'oauthClient', id: app.id, exists: false } })
})

test('没有邮件配置或没有主人不入队，停用、删除都会审计', async () => {
  const own = await client()
  await env.core.admin.disableOAuthClient(admin, own.id)
  await env.core.admin.deleteOAuthClient(admin, own.id)
  expect(await notices()).toEqual([])
  await configureMail()
  const orphan = await client(null)
  await env.core.admin.disableOAuthClient(superadmin, orphan.id)
  await env.core.admin.deleteOAuthClient(superadmin, orphan.id)
  expect(await notices()).toEqual([])
  expect(await logs()).toHaveLength(4)
})

test('列表名称包含不分大小写，client_id 精确匹配，主人筛选和分页，公用应用最前', async () => {
  const first = await client(uid, 'First APP')
  const second = await client(admin.uid, 'Second')
  const third = await client(uid, 'Literal %_!')
  const all = await env.core.admin.listOAuthClients(admin.uid, { page: 1 })
  expect(all.total).toBe(4)
  expect(all.items.map((i) => i.clientId)).toEqual(['shared', third.clientId, second.clientId, first.clientId])
  expect(all.items[0]).toMatchObject({ shared: true, owner: null, deviceCode: true, type: 'native' })
  expect((await env.core.admin.listOAuthClients(admin.uid, { q: '  app  ', page: 1 })).items.map((i) => i.id)).toEqual([
    first.id,
  ])
  expect(
    (await env.core.admin.listOAuthClients(admin.uid, { q: first.clientId, page: 1 })).items.map((i) => i.id),
  ).toEqual([first.id])
  expect(
    (await env.core.admin.listOAuthClients(admin.uid, { q: first.clientId.toUpperCase(), page: 1 })).items,
  ).toEqual([])
  expect((await env.core.admin.listOAuthClients(admin.uid, { q: '%_!', page: 1 })).items.map((i) => i.id)).toEqual([
    third.id,
  ])
  expect(await env.core.admin.listOAuthClients(admin.uid, { owner: uid, page: 1, perPage: 1 })).toMatchObject({
    total: 2,
    items: [{ id: third.id, owner: { uid, nickname: 'owner', role: 'user' } }],
    owner: { uid, nickname: 'owner' },
  })
  expect(
    (await env.core.admin.listOAuthClients(admin.uid, { owner: uid, page: 2, perPage: 1 })).items.map((i) => i.id),
  ).toEqual([first.id])
  expect(await env.core.admin.listOAuthClients(admin.uid, { owner: 2147483647, page: 1 })).toEqual({
    total: 0,
    items: [],
    owner: null,
  })
})

test('用户详情 authorizedApps 同安全页口径、按 client_id 去重，和名下应用数独立', async () => {
  const own = await client()
  const other = await client(admin.uid)
  const expired = await client(admin.uid)
  await seedOAuth(env.db, uid, null, own.clientId)
  await seedOAuth(env.db, uid, null, other.clientId)
  await seedOAuth(env.db, uid, null, expired.clientId)
  await env.db.deleteFrom('oauth_consents').where('client_id', '=', expired.clientId).execute()
  const at = writeAuthDate(env.db, toIsoTimestamp(env.now()))
  await env.db
    .updateTable('oauth_access_tokens')
    .set({ expires_at: at })
    .where('client_id', '=', expired.clientId)
    .execute()
  await env.db
    .updateTable('oauth_refresh_tokens')
    .set({ revoked: at })
    .where('client_id', '=', expired.clientId)
    .execute()
  // 同意单独存在仍计数；另一个应用只有刷新令牌也计数。
  for (const table of ['oauth_access_tokens', 'oauth_refresh_tokens'] as const)
    await env.db.deleteFrom(table).where('client_id', '=', own.clientId).execute()
  await env.db.deleteFrom('oauth_consents').where('client_id', '=', other.clientId).execute()
  await env.db.deleteFrom('oauth_access_tokens').where('client_id', '=', other.clientId).execute()
  expect(await env.core.admin.userDetail(admin.uid, uid)).toMatchObject({
    counts: { oauthClients: 1, authorizedApps: 2 },
  })
})

test('无主人的应用被两个超级管理员并发停用，只写一条审计', async () => {
  const app = await client(null)
  const second = { uid: await env.user('second-superadmin'), ip: null }
  await role(second.uid, 'superadmin')
  const pause = pauseNextCommit(env.db)
  let first: Promise<unknown> | undefined, competing: Promise<unknown> | undefined
  try {
    first = env.core.admin.disableOAuthClient(superadmin, app.id)
    await pause.entered
    competing = env.core.admin.disableOAuthClient(second, app.id)
    await pause.contended
    pause.resume()
    await Promise.all([first, competing])
    expect((await logs()).map((log) => log.action)).toEqual(['oauthClient.disable'])
  } finally {
    pause.resume()
    await Promise.allSettled([first, competing])
    pause.restore()
  }
})
