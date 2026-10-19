/**
 * 后台改动用户的用例（ADR-0036）：权限矩阵和"能对谁做"、失败整体回滚、昵称和邮箱验证状态、改积分、用户详情。
 * 按 ADR 和切片规格写，不迎合实现；删除用户在 user-management-deletion.db.test.ts，账号安全的细节在 user-security 那几个文件
 */
import { randomUUID } from 'node:crypto'
import {
  countRows,
  readAuthBoolean,
  readAuthDate,
  toIsoTimestamp,
  transactionWithRetry,
  writeAuthDate,
  type IsoTimestamp,
  type UserRole,
} from '@nextskin/db'
import { hashPassword } from 'better-auth/crypto'
import { beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { can, type CorePermission } from '../access/permissions.ts'
import type { AuditAction } from '../audit/write.ts'
import { old, setup } from '../closet/test-support.ts'
import { MAIL_JOB } from '../mail/service.ts'
import { adjustScore } from '../score/adjust.ts'
import type { AdminActor } from './types.ts'

// 授权表落地之前，两种管理员的后台权限都是全的（ADR-0036"权限"）。从 admin 身上拿掉某一项，才能验证每个用例各查各的权限
vi.mock('../access/permissions.ts', { spy: true })
// 看后台改密码有没有在预检之前就算哈希
vi.mock('better-auth/crypto', { spy: true })
const permissions = await vi.importActual<typeof import('../access/permissions.ts')>('../access/permissions.ts')

const env = setup()
const root = 'http://localhost:3000'
const future = toIsoTimestamp(new Date('2030-01-01T00:00:00Z'))
const missing = 2147483647
let admin: AdminActor, superadmin: AdminActor, hash: string

beforeAll(async () => {
  hash = await hashPassword('password123')
})
beforeEach(async () => {
  vi.mocked(can).mockImplementation(permissions.can)
  await env.db().deleteFrom('audit_logs').execute()
  // 找回链接、两步验证挑战这些记录不挂在用户的外键上，删用户带不走
  await env.db().deleteFrom('verifications').execute()
  admin = { ...(await env.user('admin')), ip: '2001:db8::1' }
  superadmin = { ...(await env.user('superadmin')), ip: '192.0.2.1' }
  await role(admin.uid, 'admin')
  await role(superadmin.uid, 'superadmin')
  env.subscribe(
    'user.profileUpdated',
    'user.roleChanged',
    'user.deleted',
    'player.deleted',
    'closet.itemRemoved',
    'texture.deleted',
  )
})

function deny(roleValue: UserRole, permission: CorePermission) {
  vi.mocked(can).mockImplementation((r, p) => !(r === roleValue && p === permission) && permissions.can(r, p))
}
const authDate = (value: IsoTimestamp = old) => writeAuthDate(env.db(), value)
async function role(uid: number, value: UserRole) {
  await env.db().updateTable('users').set({ role: value }).where('id', '=', uid).execute()
}
async function configureMail() {
  await env.setting('mail.transport', 'smtp')
  await env.setting('mail.from', { address: 'sender@example.test', name: 'NextSkin' })
}
async function credential(uid: number, password: string | null = hash) {
  await env
    .db()
    .insertInto('accounts')
    .values({
      user_id: uid,
      provider_id: 'credential',
      account_id: String(uid),
      password,
      created_at: authDate(),
      updated_at: authDate(),
    })
    .execute()
}
/** 第三方绑定。默认的插件没有安装，算停用了的绑定：总能解，也不算能用的登录方式（ADR-0036"解绑第三方账号"） */
async function binding(uid: number, plugin = 'gone', provider = 'github') {
  await env
    .db()
    .insertInto('accounts')
    .values({
      user_id: uid,
      provider_id: `plugin:${plugin}:${provider}`,
      account_id: `subject-${uid}`,
      created_at: authDate(),
      updated_at: authDate(),
    })
    .execute()
}
async function passkey(uid: number) {
  await env
    .db()
    .insertInto('passkeys')
    .values({
      user_id: uid,
      name: 'Key',
      public_key: 'test-key',
      credential_id: `key-${randomUUID()}`,
      counter: 0,
      device_type: 'multiDevice',
      backed_up: true,
      transports: null,
      created_at: authDate(),
      aaguid: null,
    })
    .execute()
}
async function twoFactor(uid: number) {
  await env
    .db()
    .insertInto('two_factors')
    .values({
      user_id: uid,
      secret: 'test-secret',
      backup_codes: 'test-codes',
      verified: true,
      failed_verification_count: 0,
      locked_until: null,
    })
    .execute()
  await env.db().updateTable('users').set({ two_factor_enabled: true }).where('id', '=', uid).execute()
}
async function session(uid: number, expiresAt = future) {
  await env
    .db()
    .insertInto('sessions')
    .values({
      user_id: uid,
      token: `session-${randomUUID()}`,
      created_at: authDate(),
      updated_at: authDate(),
      expires_at: authDate(expiresAt),
      ip_address: null,
      user_agent: null,
    })
    .execute()
}
async function launcherToken(uid: number, expiresAt = future) {
  await env
    .db()
    .insertInto('yggdrasil_tokens')
    .values({
      access_token_hash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
      client_token: randomUUID(),
      user_id: uid,
      player_id: null,
      created_at: old,
      valid_until: expiresAt,
      expires_at: expiresAt,
    })
    .execute()
}
async function resetLink(uid: number) {
  await env
    .db()
    .insertInto('verifications')
    .values({
      identifier: `reset-password:${randomUUID()}`,
      value: String(uid),
      expires_at: authDate(future),
      created_at: authDate(),
      updated_at: authDate(),
    })
    .execute()
}
async function logs() {
  return (await env.db().selectFrom('audit_logs').selectAll().orderBy('id').execute()).map((row) => ({
    ...row,
    details: JSON.parse(row.details) as Record<string, unknown>,
  }))
}
async function userRow(uid: number) {
  return env.db().selectFrom('users').selectAll().where('id', '=', uid).executeTakeFirstOrThrow()
}
/** 用例可能碰到的每张表；失败的请求前后应当完全相同 */
async function snapshot() {
  const db = env.db()
  return {
    users: await db.selectFrom('users').selectAll().orderBy('id').execute(),
    accounts: await db.selectFrom('accounts').selectAll().orderBy('id').execute(),
    sessions: await db.selectFrom('sessions').selectAll().orderBy('id').execute(),
    passkeys: await db.selectFrom('passkeys').selectAll().orderBy('id').execute(),
    twoFactors: await db.selectFrom('two_factors').selectAll().orderBy('id').execute(),
    verifications: await db.selectFrom('verifications').selectAll().orderBy('id').execute(),
    launcherTokens: await db.selectFrom('yggdrasil_tokens').selectAll().orderBy('id').execute(),
    players: await db.selectFrom('players').selectAll().orderBy('id').execute(),
    textures: await db.selectFrom('textures').selectAll().orderBy('id').execute(),
    closet: await db.selectFrom('closet_items').selectAll().orderBy('user_id').orderBy('texture_id').execute(),
    score: await db.selectFrom('score_transactions').selectAll().orderBy('id').execute(),
    oauthClients: await db.selectFrom('oauth_clients').select(['id', 'user_id']).orderBy('id').execute(),
    audit: await db.selectFrom('audit_logs').selectAll().orderBy('id').execute(),
    jobs: await db.selectFrom('jobs').selectAll().orderBy('id').execute(),
  }
}
/** 每个用户的流水之和等于余额 */
async function balanced() {
  for (const user of await env.db().selectFrom('users').select(['id', 'score']).execute()) {
    const entries = await env
      .db()
      .selectFrom('score_transactions')
      .select('delta')
      .where('user_id', '=', user.id)
      .execute()
    expect(entries.reduce((sum, entry) => sum + entry.delta, 0)).toBe(user.score)
  }
}
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

interface Operation {
  name: string
  /** 成功时写的审计动作 */
  action: AuditAction
  /** 准备好让用例真正有事可做的状态：权限检查漏掉时，快照会变 */
  prepare?: (uid: number) => Promise<void>
  run: (actor: AdminActor, uid: number) => Promise<unknown>
}
const operations: Operation[] = [
  {
    name: 'updateUser 改昵称',
    action: 'user.setNickname',
    run: (actor, uid) => env.core.admin.updateUser(actor, uid, { nickname: `renamed-${uid}` }),
  },
  {
    name: 'updateUser 改验证状态',
    action: 'user.setEmailVerified',
    run: (actor, uid) => env.core.admin.updateUser(actor, uid, { emailVerified: false }),
  },
  {
    name: 'changeUserEmail',
    action: 'user.setEmail',
    run: (actor, uid) => env.core.admin.changeUserEmail(actor, uid, { email: `fresh-${uid}@example.test` }, root),
  },
  {
    name: 'setUserPassword',
    action: 'user.setPassword',
    run: (actor, uid) => env.core.admin.setUserPassword(actor, uid, { password: 'brand new password' }),
  },
  {
    name: 'disableUserTwoFactor',
    action: 'user.disableTwoFactor',
    prepare: twoFactor,
    run: (actor, uid) => env.core.admin.disableUserTwoFactor(actor, uid),
  },
  {
    name: 'deleteUserPasskeys',
    action: 'user.deletePasskeys',
    prepare: async (uid) => {
      await credential(uid)
      await passkey(uid)
    },
    run: (actor, uid) => env.core.admin.deleteUserPasskeys(actor, uid),
  },
  {
    name: 'unlinkUserAccount',
    action: 'user.unlinkAccount',
    prepare: (uid) => binding(uid),
    run: (actor, uid) => env.core.admin.unlinkUserAccount(actor, uid, 'gone', 'github'),
  },
  {
    name: 'revokeUserSessions',
    action: 'user.revokeSessions',
    prepare: async (uid) => {
      await session(uid)
      await launcherToken(uid)
    },
    run: (actor, uid) => env.core.admin.revokeUserSessions(actor, uid),
  },
  {
    name: 'adjustUserScore',
    action: 'user.adjustScore',
    run: (actor, uid) => env.core.admin.adjustUserScore(actor, uid, { delta: 10 }),
  },
  {
    name: 'deleteUser',
    action: 'user.delete',
    run: (actor, uid) => env.core.admin.deleteUser(actor, uid, { publicTextures: 'keep' }),
  },
  {
    name: 'deleteUser 连公开材质一起删',
    action: 'user.delete',
    // 每个对象一个公开材质：逐个删材质之前漏查"能对谁做"的话，快照里的材质会少
    prepare: async (uid) => {
      const tid = await env.texture()
      await env.db().updateTable('textures').set({ uploader_id: uid }).where('id', '=', tid).execute()
    },
    run: (actor, uid) => env.core.admin.deleteUser(actor, uid, { publicTextures: 'delete' }),
  },
]

test.each(operations)(
  '$name：没有权限、对象是自己或不低于自己、对象不存在都拒绝且不留痕迹；对象被封禁也能做',
  async (operation) => {
    const peer = await env.user('peer'),
      banned = await env.user('banned')
    await role(peer.uid, 'admin')
    await role(banned.uid, 'banned')
    for (const uid of [env.actor.uid, admin.uid, peer.uid, superadmin.uid, banned.uid]) await operation.prepare?.(uid)
    const before = await snapshot()
    // 普通用户和被封禁的人没有后台权限
    for (const actor of [
      { uid: env.owner.uid, ip: null },
      { uid: banned.uid, ip: null },
    ])
      await expect(operation.run(actor, env.actor.uid)).rejects.toMatchObject({ code: 'permission_denied' })
    // 这些操作都要 users.manage，只有 users.ban 不够
    deny('admin', 'users.manage')
    await expect(operation.run(admin, env.actor.uid)).rejects.toMatchObject({ code: 'permission_denied' })
    vi.mocked(can).mockImplementation(permissions.can)
    // 后台动不了自己，普通管理员动不了其他管理员，谁都动不了超级管理员
    for (const [actor, uid] of [
      [admin, admin.uid],
      [admin, peer.uid],
      [admin, superadmin.uid],
      [superadmin, superadmin.uid],
    ] as const)
      await expect(operation.run(actor, uid)).rejects.toMatchObject({ code: 'user_not_manageable' })
    await expect(operation.run(admin, missing)).rejects.toMatchObject({ code: 'user_not_found' })
    expect(await snapshot()).toEqual(before)
    await operation.run(admin, banned.uid)
    await operation.run(superadmin, peer.uid)
    expect(
      (await logs())
        .filter((row) => row.action === operation.action)
        .map((row) => ({ subject: [row.subject_type, row.subject_id], actor: row.actor_user_id, ip: row.ip })),
    ).toEqual([
      { subject: ['user', banned.uid], actor: admin.uid, ip: admin.ip },
      { subject: ['user', peer.uid], actor: superadmin.uid, ip: superadmin.ip },
    ])
  },
)

test('setUserPassword 先预检再算哈希：没有权限、动不了对象、对象不存在时都不算，scrypt 很贵', async () => {
  const input = { password: 'brand new password' }
  vi.mocked(hashPassword).mockClear()
  await expect(
    env.core.admin.setUserPassword({ uid: env.owner.uid, ip: null }, env.actor.uid, input),
  ).rejects.toMatchObject({ code: 'permission_denied' })
  await expect(env.core.admin.setUserPassword(admin, superadmin.uid, input)).rejects.toMatchObject({
    code: 'user_not_manageable',
  })
  await expect(env.core.admin.setUserPassword(admin, missing, input)).rejects.toMatchObject({ code: 'user_not_found' })
  expect(hashPassword).not.toHaveBeenCalled()
  await env.core.admin.setUserPassword(admin, env.actor.uid, input)
  expect(hashPassword).toHaveBeenCalledOnce()
})

const rollbackCases: [string, (uid: number) => Promise<unknown>][] = [
  [
    'updateUser',
    (uid) => env.core.admin.updateUser(admin, uid, { nickname: 'Rolled', emailVerified: false, role: 'banned' }),
  ],
  ['changeUserEmail', (uid) => env.core.admin.changeUserEmail(admin, uid, { email: 'rolled@example.test' }, root)],
  [
    'setUserPassword',
    (uid) =>
      env.core.admin.setUserPassword(admin, uid, {
        password: 'rolled back password',
        removeOtherMethods: true,
        newEmail: 'rolled@example.test',
      }),
  ],
  ['disableUserTwoFactor', (uid) => env.core.admin.disableUserTwoFactor(admin, uid)],
  ['deleteUserPasskeys', (uid) => env.core.admin.deleteUserPasskeys(admin, uid)],
  ['unlinkUserAccount', (uid) => env.core.admin.unlinkUserAccount(admin, uid, 'gone', 'github')],
  ['revokeUserSessions', (uid) => env.core.admin.revokeUserSessions(admin, uid)],
  ['adjustUserScore', (uid) => env.core.admin.adjustUserScore(admin, uid, { delta: -10, note: 'rolled' })],
  ['deleteUser', (uid) => env.core.admin.deleteUser(admin, uid, { publicTextures: 'keep' })],
]

test.each(rollbackCases)('%s：业务做完之后提交失败，整体回滚，没有审计、事件和通知', async (_, run) => {
  await configureMail()
  const uid = env.actor.uid
  await credential(uid)
  await passkey(uid)
  await binding(uid)
  await twoFactor(uid)
  await session(uid)
  await launcherToken(uid)
  await resetLink(uid)
  await env.core.players.create(env.actor, { name: 'Steve' })
  const before = await snapshot()
  let written = 0
  const transaction = env.db().transaction.bind(env.db())
  const spy = vi.spyOn(env.db(), 'transaction').mockImplementation(() => {
    const builder = transaction(),
      execute = builder.execute.bind(builder)
    builder.execute = (callback) =>
      execute(async (tx) => {
        await callback(tx)
        written += await countRows(tx.selectFrom('audit_logs'))
        throw new Error('模拟提交失败')
      })
    return builder
  })
  try {
    await expect(run(uid)).rejects.toThrow('模拟提交失败')
  } finally {
    spy.mockRestore()
  }
  // 确认用例确实在事务里写了审计，回滚才有意义
  expect(written).toBeGreaterThan(0)
  expect(await snapshot()).toEqual(before)
})

test('updateUser 至少一项；验证状态设成 true 时必须带 expectedEmail', async () => {
  for (const input of [{}, { expectedEmail: 'actor@example.test' }, { emailVerified: true }])
    await expect(env.core.admin.updateUser(admin, env.actor.uid, input)).rejects.toMatchObject({
      code: 'invalid_request',
    })
  expect(await logs()).toEqual([])
})

test('updateUser 改昵称：规则同注册，发 profileUpdated（actor 是管理员）、写审计，和现在相同什么也不做', async () => {
  for (const nickname of ['', '   ', '😀'.repeat(256)])
    await expect(env.core.admin.updateUser(admin, env.actor.uid, { nickname })).rejects.toMatchObject({
      code: 'nickname_invalid',
      params: { min: 1, max: 255 },
    })
  env.tick()
  expect(await env.core.admin.updateUser(admin, env.actor.uid, { nickname: '  新昵称  ' })).toMatchObject({
    uid: env.actor.uid,
    nickname: '新昵称',
    role: 'user',
  })
  expect(readAuthDate((await userRow(env.actor.uid)).updated_at)).toBe(env.now())
  expect(await env.events('user.profileUpdated')).toMatchObject([
    { actor: { kind: 'user', uid: admin.uid, role: 'admin' }, data: { uid: env.actor.uid, fields: ['nickname'] } },
  ])
  expect(await logs()).toMatchObject([
    {
      action: 'user.setNickname',
      actor_type: 'user',
      actor_user_id: admin.uid,
      subject_type: 'user',
      subject_id: env.actor.uid,
      ip: admin.ip,
      details: { from: 'actor', to: '新昵称' },
    },
  ])
  expect((await logs())[0]?.details).toEqual({ from: 'actor', to: '新昵称' })
  await env.core.admin.updateUser(admin, env.actor.uid, { nickname: '新昵称 ' })
  expect(await env.events('user.profileUpdated')).toHaveLength(1)
  expect(await logs()).toHaveLength(1)
})

test('updateUser 改验证状态：两个方向都行，不发事件；expectedEmail 和现在的邮箱不同时 409 且状态不变；相同不写审计', async () => {
  const uid = env.actor.uid
  const verified = async () => readAuthBoolean((await userRow(uid)).email_verified)
  expect(await env.core.admin.updateUser(admin, uid, { emailVerified: false })).toMatchObject({ emailVerified: false })
  expect(await verified()).toBe(false)
  await env.core.admin.updateUser(admin, uid, { emailVerified: false })
  expect((await logs()).map((row) => row.details)).toEqual([
    { nickname: 'actor', email: 'actor@example.test', from: true, to: false },
  ])
  // 管理员停在旧页面上时，另一个管理员（或者用户自己）已经把邮箱改了
  await env.db().updateTable('users').set({ email: 'changed@example.test' }).where('id', '=', uid).execute()
  for (const expectedEmail of ['actor@example.test', 'other@example.test'])
    await expect(env.core.admin.updateUser(admin, uid, { emailVerified: true, expectedEmail })).rejects.toMatchObject({
      code: 'email_changed',
    })
  expect(await verified()).toBe(false)
  expect(await logs()).toHaveLength(1)
  expect(
    await env.core.admin.updateUser(admin, uid, { emailVerified: true, expectedEmail: 'changed@example.test' }),
  ).toMatchObject({ emailVerified: true, email: 'changed@example.test' })
  expect(await verified()).toBe(true)
  await env.core.admin.updateUser(admin, uid, { emailVerified: true, expectedEmail: 'changed@example.test' })
  const audit = await logs()
  expect(audit.map((row) => [row.action, row.subject_id, row.actor_user_id, row.ip])).toEqual([
    ['user.setEmailVerified', uid, admin.uid, admin.ip],
    ['user.setEmailVerified', uid, admin.uid, admin.ip],
  ])
  expect(audit[1]?.details).toEqual({ nickname: 'actor', email: 'changed@example.test', from: false, to: true })
  expect(await env.events('user.profileUpdated')).toEqual([])
})

test('updateUser 一次改昵称和验证状态写两条审计；其中一项失败时同一请求里的其他项一起回滚', async () => {
  const uid = env.actor.uid
  expect(await env.core.admin.updateUser(admin, uid, { nickname: 'Both', emailVerified: false })).toMatchObject({
    nickname: 'Both',
    emailVerified: false,
  })
  expect((await logs()).map((row) => row.action).sort()).toEqual(['user.setEmailVerified', 'user.setNickname'])
  expect(await env.events('user.profileUpdated')).toHaveLength(1)
  await expect(
    env.core.admin.updateUser(admin, uid, {
      role: 'banned',
      nickname: 'Again',
      emailVerified: true,
      expectedEmail: 'wrong@example.test',
    }),
  ).rejects.toMatchObject({ code: 'email_changed' })
  expect(await userRow(uid)).toMatchObject({ nickname: 'Both', role: 'user' })
  expect(await logs()).toHaveLength(2)
  expect(await env.events('user.profileUpdated')).toHaveLength(1)
  expect(await env.events('user.roleChanged')).toEqual([])
})

test('updateUser 的 role 仍然只要 users.ban；昵称和验证状态要 users.manage；改成 admin 还要 users.appointAdmin', async () => {
  const uid = env.actor.uid
  deny('admin', 'users.manage')
  expect(await env.core.admin.updateUser(admin, uid, { role: 'banned' })).toMatchObject({ role: 'banned' })
  for (const input of [{ nickname: 'X' }, { emailVerified: false }, { role: 'user' as const, nickname: 'X' }])
    await expect(env.core.admin.updateUser(admin, uid, input)).rejects.toMatchObject({ code: 'permission_denied' })
  expect(await userRow(uid)).toMatchObject({ role: 'banned', nickname: 'actor' })
  expect(await env.core.admin.setRole(admin, uid, 'user')).toMatchObject({ role: 'user' })
  deny('admin', 'users.ban')
  await expect(env.core.admin.updateUser(admin, uid, { role: 'banned' })).rejects.toMatchObject({
    code: 'permission_denied',
  })
  expect(await env.core.admin.updateUser(admin, uid, { nickname: 'Managed' })).toMatchObject({ nickname: 'Managed' })
  vi.mocked(can).mockImplementation(permissions.can)
  await expect(env.core.admin.updateUser(admin, uid, { role: 'admin' })).rejects.toMatchObject({
    code: 'permission_denied',
  })
  expect(await env.core.admin.updateUser(superadmin, uid, { role: 'admin' })).toMatchObject({ role: 'admin' })
  expect((await logs()).map((row) => row.action)).toEqual([
    'user.setRole',
    'user.setRole',
    'user.setNickname',
    'user.setRole',
  ])
})

test('对象被封禁时：配置了邮件的改邮箱 403 user_banned，不写审计、不发通知；收回账号和没有配置邮件时的改邮箱照常', async () => {
  const uid = env.actor.uid
  await role(uid, 'banned')
  await configureMail()
  const before = await userRow(uid)
  await expect(
    env.core.admin.changeUserEmail(admin, uid, { email: 'new@example.test', verified: true }, root),
  ).rejects.toMatchObject({ code: 'user_banned' })
  expect(await userRow(uid)).toEqual(before)
  expect(await logs()).toEqual([])
  expect(await env.db().selectFrom('jobs').selectAll().execute()).toEqual([])
  // 收回账号：新地址立即生效、算已验证，配置了邮件也不发确认链接
  await env.core.admin.setUserPassword(admin, uid, { password: 'a new password', newEmail: 'reclaimed@example.test' })
  expect(await userRow(uid)).toMatchObject({ email: 'reclaimed@example.test', role: 'banned' })
  expect(readAuthBoolean((await userRow(uid)).email_verified)).toBe(true)
  await env.setting('mail.transport', 'none')
  // 不查邮箱域名的名单：管理员是有意为之（ADR-0036"改邮箱"）
  await env.setting('auth.registration.emailDomains', { mode: 'allow', domains: ['allowed.test'] })
  expect(
    await env.core.admin.changeUserEmail(admin, uid, { email: ' Direct@Example.TEST ', verified: true }, root),
  ).toMatchObject({ status: 'changed', user: { uid, email: 'direct@example.test', emailVerified: true } })
  expect((await logs()).filter((row) => row.action === 'user.setEmail').map((row) => row.details)).toEqual([
    { nickname: 'actor', from: 'actor@example.test', to: 'reclaimed@example.test', pending: false, verified: true },
    { nickname: 'actor', from: 'reclaimed@example.test', to: 'direct@example.test', pending: false, verified: true },
  ])
})

test('改积分：增量不是非零安全整数或超界、备注超长或带 NUL 都是 invalid_request；扣到负数、加过上限是 score_out_of_range 并带余额', async () => {
  const uid = env.actor.uid
  await configureMail()
  for (const delta of [0, -0, 1.5, -0.5, Number.NaN, Infinity, 2147483648, -2147483648, Number.MAX_SAFE_INTEGER + 2])
    await expect(env.core.admin.adjustUserScore(admin, uid, { delta })).rejects.toMatchObject({
      code: 'invalid_request',
    })
  for (const note of ['x'.repeat(201), 'a\u0000b'])
    await expect(env.core.admin.adjustUserScore(admin, uid, { delta: 1, note })).rejects.toMatchObject({
      code: 'invalid_request',
    })
  await expect(env.core.admin.adjustUserScore(admin, uid, { delta: -1001 })).rejects.toMatchObject({
    code: 'score_out_of_range',
    params: { balance: 1000 },
  })
  expect(await env.balance(uid)).toBe(1000)
  expect(await logs()).toEqual([])
  expect(await env.core.admin.adjustUserScore(admin, uid, { delta: -1000, note: '  清零  ' })).toEqual({ score: 0 })
  expect(await env.core.admin.adjustUserScore(admin, uid, { delta: 2147483647, note: 'x'.repeat(200) })).toEqual({
    score: 2147483647,
  })
  await expect(env.core.admin.adjustUserScore(admin, uid, { delta: 1 })).rejects.toMatchObject({
    code: 'score_out_of_range',
    params: { balance: 2147483647 },
  })
  expect(await env.core.admin.adjustUserScore(admin, uid, { delta: -2147483647, note: '   ' })).toEqual({ score: 0 })
  expect(await env.ledger(uid)).toEqual([
    {
      delta: -1000,
      reason: 'score.reasons.adminAdjusted',
      subject_type: null,
      subject_id: null,
      created_at: env.now(),
    },
    {
      delta: 2147483647,
      reason: 'score.reasons.adminAdjusted',
      subject_type: null,
      subject_id: null,
      created_at: env.now(),
    },
    {
      delta: -2147483647,
      reason: 'score.reasons.adminAdjusted',
      subject_type: null,
      subject_id: null,
      created_at: env.now(),
    },
  ])
  const audit = await logs()
  expect(audit.every((row) => row.action === 'user.adjustScore' && row.subject_id === uid && row.ip === admin.ip)).toBe(
    true,
  )
  // 空白的备注当作没有
  expect(audit.map((row) => row.details)).toEqual([
    { nickname: 'actor', delta: -1000, from: 1000, to: 0, note: '清零' },
    { nickname: 'actor', delta: 2147483647, from: 0, to: 2147483647, note: 'x'.repeat(200) },
    { nickname: 'actor', delta: -2147483647, from: 2147483647, to: 0 },
  ])
  // 积分变动不发事件，也不通知
  expect(await env.db().selectFrom('jobs').selectAll().execute()).toEqual([])
  expect(await countRows(env.db().selectFrom('jobs').where('name', '=', MAIL_JOB))).toBe(0)
  await balanced()
})

test('改积分：余额为负的导入用户可以加分，加完仍为负也行，但不能再扣', async () => {
  const uid = env.actor.uid
  // 导入器原样导入 BS 的负积分
  await env.db().deleteFrom('score_transactions').where('user_id', '=', uid).execute()
  await env.db().updateTable('users').set({ score: -50 }).where('id', '=', uid).execute()
  await env
    .db()
    .insertInto('score_transactions')
    .values({ user_id: uid, delta: -50, balance: -50, reason: 'score.reasons.initial', created_at: old })
    .execute()
  expect(await env.core.admin.adjustUserScore(admin, uid, { delta: 20 })).toEqual({ score: -30 })
  await expect(env.core.admin.adjustUserScore(admin, uid, { delta: -1 })).rejects.toMatchObject({
    code: 'score_out_of_range',
    params: { balance: -30 },
  })
  expect(await env.core.admin.adjustUserScore(admin, uid, { delta: 2147483647 })).toEqual({ score: 2147483617 })
  expect((await logs()).map((row) => row.details)).toEqual([
    { nickname: 'actor', delta: 20, from: -50, to: -30 },
    { nickname: 'actor', delta: 2147483647, from: -30, to: 2147483617 },
  ])
  await balanced()
})

test('改积分和用户自己的花费并发，不丢失任何一笔，流水之和等于余额', async () => {
  const uid = env.actor.uid
  await env.setting('score.perClosetItem', 30)
  const tids = [await env.texture(), await env.texture(), await env.texture()]
  await Promise.all([
    env.core.admin.adjustUserScore(admin, uid, { delta: 100 }),
    env.core.closet.add(env.actor, { tid: tids[0]! }),
    env.core.admin.adjustUserScore(superadmin, uid, { delta: -200 }),
    env.core.closet.add(env.actor, { tid: tids[1]! }),
    env.core.admin.adjustUserScore(admin, uid, { delta: 7 }),
  ])
  expect(await env.balance(uid)).toBe(1000 + 100 - 30 - 200 - 30 + 7)
  expect(await env.ledger(uid)).toHaveLength(5)
  // 用户的花费停在提交之前，后台的调整这时开始，必须排在它后面读余额
  const pause = env.pauseNextCommit()
  const leading = env.core.closet.add(env.actor, { tid: tids[2]! })
  let trailing: Promise<unknown> | undefined
  try {
    await pause.entered
    trailing = env.core.admin.adjustUserScore(admin, uid, { delta: 1 })
    await Promise.race([pause.contended, delay(200)])
    pause.resume()
    await leading
    expect(await trailing).toEqual({ score: 847 - 30 + 1 })
  } finally {
    pause.resume()
    await leading
    await trailing
    pause.restore()
  }
  expect(await env.balance(uid)).toBe(818)
  expect((await logs()).at(-1)?.details).toEqual({ nickname: 'actor', delta: 1, from: 817, to: 818 })
  for (const tid of tids) await env.consistent(tid)
})

test('userDetail：未过期的会话和令牌、各项计数、有没有密码、前 100 个角色、最近 10 条流水和审计', async () => {
  const uid = env.owner.uid
  await env.db().updateTable('users').set({ locale: 'en', two_factor_enabled: true }).where('id', '=', uid).execute()
  await session(uid)
  await session(uid)
  await session(uid, old)
  await session(env.actor.uid)
  await launcherToken(uid)
  await launcherToken(uid, old)
  await launcherToken(env.actor.uid)
  await passkey(uid)
  await passkey(uid)
  await passkey(env.actor.uid)
  // 名下 102 个角色，详情只列前 100 个
  await env
    .db()
    .insertInto('players')
    .values(
      Array.from({ length: 102 }, (_, i) => ({
        user_id: uid,
        name: `owned${i}`,
        name_key: `owned${i}`,
        uuid: randomUUID().replaceAll('-', ''),
        skin_texture_id: null,
        cape_texture_id: null,
        created_at: old,
        updated_at: old,
      })),
    )
    .execute()
  await env.core.players.create(env.actor, { name: 'NotOwned' })
  await env.texture()
  await env.texture()
  await env.texture('steve', false)
  const foreign = await env.texture()
  await env.db().updateTable('textures').set({ uploader_id: env.actor.uid }).where('id', '=', foreign).execute()
  await env
    .db()
    .insertInto('closet_items')
    .values({ user_id: uid, texture_id: foreign, name: 'Foreign', score_paid: 0, created_at: old })
    .execute()
  for (const owner of [uid, env.actor.uid])
    await env
      .db()
      .insertInto('oauth_clients')
      .values({ user_id: owner, client_id: `client-${owner}`, redirect_uris: '[]' })
      .execute()
  await transactionWithRetry(env.db(), async (tx) => {
    for (let delta = 1; delta <= 11; delta++)
      await adjustScore(tx, { uid, delta, reason: 'score.reasons.adminAdjusted', now: env.now() })
  })
  for (const subject of [...Array<number>(12).fill(uid), env.actor.uid])
    await env
      .db()
      .insertInto('audit_logs')
      .values({
        actor_type: 'user',
        actor_user_id: admin.uid,
        action: 'user.adjustScore',
        subject_type: 'user',
        subject_id: subject,
        details: '{}',
        ip: admin.ip,
        created_at: env.now(),
      })
      .execute()
  const detail = await env.core.admin.userDetail(admin.uid, uid)
  expect(detail).toMatchObject({
    user: {
      uid,
      nickname: 'owner',
      email: 'owner@example.test',
      emailVerified: true,
      role: 'user',
      score: 1066,
      registeredAt: old,
      locale: 'en',
      twoFactorEnabled: true,
    },
    hasPassword: false,
    counts: {
      sessions: 2,
      launcherTokens: 1,
      passkeys: 2,
      players: 102,
      publicTextures: 2,
      privateTextures: 1,
      closetItems: 1,
      oauthClients: 1,
    },
  })
  const players = await env
    .db()
    .selectFrom('players')
    .select(['id', 'name', 'uuid'])
    .where('user_id', '=', uid)
    .orderBy('id')
    .limit(100)
    .execute()
  expect(detail!.players).toEqual(players.map((p) => ({ pid: p.id, name: p.name, uuid: p.uuid })))
  // 最近的在前
  expect(detail!.recentScore.map((entry) => entry.delta)).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2])
  expect(detail!.recentScore[0]).toEqual({
    id: expect.any(Number) as unknown,
    delta: 11,
    balance: 1066,
    reason: 'score.reasons.adminAdjusted',
    createdAt: env.now(),
  })
  const auditIds = (
    await env
      .db()
      .selectFrom('audit_logs')
      .select('id')
      .where('subject_type', '=', 'user')
      .where('subject_id', '=', uid)
      .orderBy('id', 'desc')
      .limit(10)
      .execute()
  ).map((row) => row.id)
  expect(detail!.recentAudit.map((entry) => entry.id)).toEqual(auditIds)
  expect(detail!.recentAudit.every((entry) => entry.subject.type === 'user' && entry.subject.id === uid)).toBe(true)
  expect(detail!.recentAudit[0]).toMatchObject({
    action: 'user.adjustScore',
    actor: { type: 'user', uid: admin.uid, nickname: 'admin' },
    subject: { exists: true },
    ip: admin.ip,
  })
  // 密码行在、但密码为空不算有密码
  await credential(uid, null)
  expect((await env.core.admin.userDetail(admin.uid, uid))?.hasPassword).toBe(false)
  await env.db().updateTable('accounts').set({ password: hash }).where('user_id', '=', uid).execute()
  expect((await env.core.admin.userDetail(admin.uid, uid))?.hasPassword).toBe(true)
})

test('userDetail 只要 users.ban，不看对象的身份；没有 users.ban 时 permission_denied，用户不存在返回 null', async () => {
  const banned = await env.user('banned')
  await role(banned.uid, 'banned')
  for (const viewer of [env.actor.uid, banned.uid])
    await expect(env.core.admin.userDetail(viewer, env.owner.uid)).rejects.toMatchObject({ code: 'permission_denied' })
  deny('admin', 'users.ban')
  await expect(env.core.admin.userDetail(admin.uid, env.owner.uid)).rejects.toMatchObject({
    code: 'permission_denied',
  })
  deny('admin', 'users.manage')
  expect(await env.core.admin.userDetail(admin.uid, env.owner.uid)).toMatchObject({ user: { uid: env.owner.uid } })
  vi.mocked(can).mockImplementation(permissions.can)
  expect(await env.core.admin.userDetail(admin.uid, superadmin.uid)).toMatchObject({
    user: { uid: superadmin.uid, role: 'superadmin' },
    hasPassword: false,
    counts: { sessions: 0, launcherTokens: 0, passkeys: 0, players: 0 },
    players: [],
  })
  expect(await env.core.admin.userDetail(admin.uid, missing)).toBeNull()
})
