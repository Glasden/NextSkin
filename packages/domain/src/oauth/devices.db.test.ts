import { toIsoTimestamp } from '@nextskin/db'
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { oauthFixture } from './oauth.test-helper.ts'
import { JOIN_SCOPE, READ_SCOPE, SELECT_SCOPE } from './scopes.ts'

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
const approve = (code = 'ABCDEFGH', selected: number | null = pid) =>
  env.core.oauth.approveDevice(uid, { userCode: code, pid: selected })
const deny = (code = 'ABCDEFGH') => env.core.oauth.denyDevice(uid, { userCode: code })

test('小写、连字符、首尾空格规范化，返回表中原码；字符集外字符不再查', async () => {
  await env.device()
  expect(await env.core.oauth.openDevice(uid, '  abcd-efgh  ')).toMatchObject({
    status: 'pending',
    userCode: 'ABCDEFGH',
    scopes: ['openid', SELECT_SCOPE],
    client: { shared: true, name: null, owner: null },
  })
  await env.device({ code: 'ABCDIFGH' })
  expect(await env.core.oauth.openDevice(uid, 'abcd-ifgh')).toEqual({ status: 'invalid' })
  expect(await env.core.oauth.openDevice(uid, 'A'.repeat(65))).toEqual({ status: 'invalid' })
})

test('认领只发生在待批准且没人认领时；过期、停用、应用不存在不认领', async () => {
  const row = await env.device()
  expect((await env.core.oauth.openDevice(uid, row.user_code)).status).toBe('pending')
  expect(await env.core.oauth.openDevice(other, row.user_code)).toEqual({ status: 'claimed' })
  for (const status of ['approved', 'denied']) {
    await env.db.updateTable('device_codes').set({ user_id: null, status }).where('id', '=', row.id).execute()
    expect(await env.core.oauth.openDevice(uid, row.user_code)).toEqual({ status: 'claimed' })
  }
  await env.db.deleteFrom('device_codes').execute()
  const expired = await env.device({ expires: 0 })
  expect(await env.core.oauth.openDevice(uid, expired.user_code)).toEqual({ status: 'expired' })
  expect((await env.db.selectFrom('device_codes').selectAll().executeTakeFirstOrThrow()).user_id).toBeNull()
  await env.db.deleteFrom('device_codes').execute()
  await env.device()
  await env.db.updateTable('oauth_clients').set({ disabled: true }).where('client_id', '=', 'shared').execute()
  expect(await env.core.oauth.openDevice(uid, 'ABCDEFGH')).toEqual({ status: 'invalid' })
  await env.db.updateTable('device_codes').set({ client_id: 'missing' }).execute()
  expect(await env.core.oauth.openDevice(uid, 'ABCDEFGH')).toEqual({ status: 'invalid' })
})

test('批准原子写选择和状态，不能再批准或拒绝；本人可查看处理结果', async () => {
  const row = await env.device({ uid })
  await approve()
  expect(await env.db.selectFrom('device_code_selections').selectAll().execute()).toEqual([
    { device_code: row.device_code, user_id: uid, player_id: pid, created_at: env.now().toISOString() },
  ])
  expect(await env.core.oauth.openDevice(uid, row.user_code)).toMatchObject({ status: 'approved' })
  await expect(approve()).rejects.toMatchObject({ code: 'device_code_processed' })
  await expect(deny()).rejects.toMatchObject({ code: 'device_code_processed' })
})

test('Select 必须选本人角色；失败不改状态和选择', async () => {
  await env.device({ uid })
  const otherPid = await env.player(other, 'Alex')
  for (const [selected, code] of [
    [null, 'device_player_required'],
    [otherPid, 'player_not_found'],
    [999999, 'player_not_found'],
  ] as const)
    await expect(approve('ABCDEFGH', selected)).rejects.toMatchObject({ code })
  expect(await env.db.selectFrom('device_code_selections').selectAll().execute()).toEqual([])
  expect((await env.db.selectFrom('device_codes').select('status').executeTakeFirstOrThrow()).status).toBe('pending')
})

test('不含 Select 时忽略 pid，不写选择；拒绝可重读但不能再处理', async () => {
  await env.device({ uid, scope: 'openid profile' })
  await approve('ABCDEFGH', 999999)
  expect(await env.db.selectFrom('device_code_selections').selectAll().execute()).toEqual([])
  await env.db.deleteFrom('device_codes').execute()
  await env.device({ uid })
  await deny()
  expect(await env.core.oauth.openDevice(uid, 'ABCDEFGH')).toMatchObject({ status: 'denied' })
  await expect(approve()).rejects.toMatchObject({ code: 'device_code_processed' })
})

test.each([SELECT_SCOPE, `openid ${SELECT_SCOPE} ${READ_SCOPE}`, `openid ${JOIN_SCOPE}`, 'openid unknown'])(
  '无效 scope %s 不批准',
  async (scope) => {
    await env.device({ uid, scope })
    await expect(approve()).rejects.toMatchObject({ code: 'oauth_scope_invalid' })
  },
)

test('没认领、别人认领、过期、不存在、应用停用都不能处理', async () => {
  for (const run of [approve, deny]) {
    await env.db.deleteFrom('device_codes').execute()
    await expect(run()).rejects.toMatchObject({ code: 'device_code_invalid' })
    await env.device()
    await expect(run()).rejects.toMatchObject({ code: 'device_code_claimed' })
    await env.db
      .updateTable('device_codes')
      .set({ user_id: String(other) })
      .execute()
    await expect(run()).rejects.toMatchObject({ code: 'device_code_claimed' })
    await env.db.deleteFrom('device_codes').execute()
    await env.device({ uid, expires: 0 })
    await expect(run()).rejects.toMatchObject({ code: 'device_code_expired' })
    await env.db.deleteFrom('device_codes').execute()
    await env.device({ uid })
    await env.db.updateTable('oauth_clients').set({ disabled: true }).where('client_id', '=', 'shared').execute()
    await expect(run()).rejects.toMatchObject({ code: 'device_code_invalid' })
    await env.db.updateTable('oauth_clients').set({ disabled: false }).where('client_id', '=', 'shared').execute()
  }
})

test('封禁、未验证邮箱不能批准但可以拒绝；关掉验证要求时可批准', async () => {
  await env.device({ uid })
  await env.db.updateTable('users').set({ role: 'banned' }).where('id', '=', uid).execute()
  await expect(approve()).rejects.toMatchObject({ code: 'user_banned' })
  await deny()
  await env.db.deleteFrom('device_codes').execute()
  await env.device({ uid })
  await env.db.updateTable('users').set({ role: 'user', email_verified: false }).where('id', '=', uid).execute()
  await env.db
    .insertInto('settings')
    .values({
      namespace: 'core',
      key: 'auth.requireEmailVerification',
      value: 'true',
      updated_at: toIsoTimestamp(env.now()),
    })
    .execute()
  await expect(approve()).rejects.toMatchObject({ code: 'email_not_verified' })
  await deny()
  await env.db.deleteFrom('device_codes').execute()
  await env.device({ uid })
  await env.db
    .updateTable('settings')
    .set({ value: 'false' })
    .where('key', '=', 'auth.requireEmailVerification')
    .execute()
  await approve()
})

test('两个并发批准只有一个成功，选择来自成功的那次', async () => {
  await env.device({ uid })
  const second = await env.player(uid, 'Alex')
  const selected = [pid, second]
  const results = await Promise.allSettled(selected.map((id) => approve('ABCDEFGH', id)))
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.find((result) => result.status === 'rejected')).toMatchObject({
    reason: { code: 'device_code_processed' },
  })
  expect(
    (await env.db.selectFrom('device_code_selections').select('player_id').executeTakeFirstOrThrow()).player_id,
  ).toBe(selected[results.findIndex((result) => result.status === 'fulfilled')])
})

test('三个入口共用失败次数，猜中不清零；十次之后限流，十分钟后恢复，用户间隔离', async () => {
  await env.device({ uid })
  for (let i = 0; i < 10; i++) {
    if (i === 5) expect((await env.core.oauth.openDevice(uid, 'ABCDEFGH')).status).toBe('pending')
    if (i % 3 === 0) expect(await env.core.oauth.openDevice(uid, 'missing')).toEqual({ status: 'invalid' })
    else
      await expect(i % 3 === 1 ? approve('missing') : deny('missing')).rejects.toMatchObject({
        code: 'device_code_invalid',
      })
  }
  for (const run of [() => env.core.oauth.openDevice(uid, 'ABCDEFGH'), approve, deny])
    await expect(run()).rejects.toMatchObject({ code: 'too_many_requests', params: { retryAfter: 600 } })
  expect(await env.core.oauth.openDevice(other, 'missing')).toEqual({ status: 'invalid' })
  env.advance(600_000)
  expect(await env.core.oauth.openDevice(uid, 'missing')).toEqual({ status: 'invalid' })
})

test('并发查不到的次数累计，不互相覆盖', async () => {
  const results = await Promise.all(Array.from({ length: 10 }, () => env.core.oauth.openDevice(uid, 'missing')))
  expect(results).toEqual(Array.from({ length: 10 }, () => ({ status: 'invalid' })))
  await expect(env.core.oauth.openDevice(uid, 'missing')).rejects.toMatchObject({ code: 'too_many_requests' })
})

test('同一用户并发 30 个不同错码，至多十次查库，其余限流', async () => {
  const spy = vi.spyOn(env.db, 'selectFrom')
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, (_, i) => env.core.oauth.openDevice(uid, `WRONG${i}`)),
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(10)
    const rejected = results.filter((result) => result.status === 'rejected')
    expect(rejected).toHaveLength(20)
    for (const result of rejected) expect(result).toMatchObject({ reason: { code: 'too_many_requests' } })
    expect(spy.mock.calls.filter(([table]) => table === 'device_codes')).toHaveLength(10)
  } finally {
    spy.mockRestore()
  }
})

test('查库出错不计入失败次数，数据库恢复后照常查', async () => {
  await env.device()
  const select = env.db.selectFrom.bind(env.db)
  const spy = vi.spyOn(env.db, 'selectFrom').mockImplementation(((table: never) => {
    if (table === 'device_codes') throw new Error('database unavailable')
    return select(table)
  }) as never)
  try {
    for (let i = 0; i < 12; i++)
      await expect(env.core.oauth.openDevice(uid, 'ABCDEFGH')).rejects.toThrow('database unavailable')
  } finally {
    spy.mockRestore()
  }
  expect((await env.core.oauth.openDevice(uid, 'ABCDEFGH')).status).toBe('pending')
})
