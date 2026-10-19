/**
 * 后台角色管理（ADR-0036 切片二）：权限和主人等级、改名和换材质、转让和删除、审计与通知的事务性、三个读查询。
 * 按 ADR 和切片规格断言，不迎合实现；使用四种数据库共用的辅助函数，竞态固定在提交前或刷新进入事务前。
 * 用户侧换材质的错误优先级已由 closet/lifecycle.db.test.ts 的“换材质按可见性、衣柜、槽位顺序验证”覆盖。
 */
import { randomUUID } from 'node:crypto'
import { countRows, insertReturningId, toIsoTimestamp, type CoreDatabase, type UserRole } from '@nextskin/db'
import type { Player } from '@nextskin/plugin-sdk'
import type { Transaction } from 'kysely'
import { beforeEach, expect, test, vi } from 'vitest'
import { can, type CorePermission } from '../access/permissions.ts'
import { sha256 } from '../auth/auth.ts'
import { old, setup } from '../closet/test-support.ts'
import { MAIL_JOB } from '../mail/service.ts'
import type { AdminActor } from './types.ts'

// 当前两种管理员的权限都是全的，单独拿掉一项才能证明每个入口检查了自己的权限。
vi.mock('../access/permissions.ts', { spy: true })
const permissions = await vi.importActual<typeof import('../access/permissions.ts')>('../access/permissions.ts')
const env = setup()
const missing = 2147483647
const future = toIsoTimestamp(new Date('2030-01-01T00:00:00Z'))
let admin: AdminActor, superadmin: AdminActor

beforeEach(async () => {
  vi.mocked(can).mockImplementation(permissions.can)
  await env.db().deleteFrom('audit_logs').execute()
  admin = { ...(await env.user('admin')), ip: '2001:db8::36' }
  superadmin = { ...(await env.user('superadmin')), ip: '192.0.2.36' }
  await role(admin.uid, 'admin')
  await role(superadmin.uid, 'superadmin')
  env.subscribe('player.created', 'player.renamed', 'player.texturesChanged', 'player.transferred', 'player.deleted')
})

function deny(value: UserRole, permission: CorePermission) {
  vi.mocked(can).mockImplementation((r, p) => !(r === value && p === permission) && permissions.can(r, p))
}
async function role(uid: number, value: UserRole) {
  await env.db().updateTable('users').set({ role: value }).where('id', '=', uid).execute()
}
async function configureMail() {
  await env.setting('mail.transport', 'smtp')
  await env.setting('mail.from', { address: 'sender@example.test', name: 'NextSkin' })
}
/** 模拟历史角色：实付 73 分，不要求材质在衣柜里，也允许引用主人看不到的私有材质。 */
async function player(uid = env.owner.uid, name = 'Before', skin: number | null = null, cape: number | null = null) {
  const uuid = randomUUID().replaceAll('-', '')
  const pid = await insertReturningId(env.db(), 'players', {
    user_id: uid,
    name,
    name_key: name.toLowerCase(),
    uuid,
    score_paid: 73,
    skin_texture_id: skin,
    cape_texture_id: cape,
    created_at: old,
    updated_at: old,
  })
  return { pid, uid, name, uuid, skin, cape, updatedAt: old } satisfies Player
}
async function row(pid: number) {
  return env.db().selectFrom('players').selectAll().where('id', '=', pid).executeTakeFirst()
}
async function logs() {
  return (await env.db().selectFrom('audit_logs').selectAll().orderBy('id').execute()).map((entry) => ({
    ...entry,
    details: JSON.parse(entry.details) as Record<string, unknown>,
  }))
}
async function notices() {
  return (await env.db().selectFrom('jobs').select('payload').where('name', '=', MAIL_JOB).orderBy('id').execute()).map(
    (entry) => JSON.parse(entry.payload) as Record<string, unknown>,
  )
}
async function eventJobs() {
  return (await env.db().selectFrom('jobs').selectAll().where('name', 'like', 'test:%').orderBy('id').execute()).map(
    (entry) =>
      JSON.parse(entry.payload) as {
        name: string
        actor: { kind: string; uid: number; role: string }
        data: Record<string, unknown>
      },
  )
}
async function snapshot() {
  const db = env.db()
  return {
    players: await db.selectFrom('players').selectAll().orderBy('id').execute(),
    users: await db.selectFrom('users').selectAll().orderBy('id').execute(),
    score: await db.selectFrom('score_transactions').selectAll().orderBy('id').execute(),
    tokens: await db.selectFrom('yggdrasil_tokens').selectAll().orderBy('id').execute(),
    selections: await db.selectFrom('device_code_selections').selectAll().orderBy('device_code').execute(),
    audit: await logs(),
    jobs: await db.selectFrom('jobs').selectAll().orderBy('id').execute(),
  }
}
async function unchanged(run: () => Promise<unknown>, code: string, params?: Record<string, string | number>) {
  const before = await snapshot()
  await expect(run()).rejects.toMatchObject({ code, ...(params ? { params } : {}) })
  expect(await snapshot()).toEqual(before)
}
function auditEntry(action: string, uid: number, details: Record<string, unknown>, actor = admin) {
  return {
    action,
    actor_type: 'user',
    actor_user_id: actor.uid,
    subject_type: 'user',
    subject_id: uid,
    ip: actor.ip,
    created_at: env.now(),
    details,
  }
}
async function launcherToken(uid: number, pid: number | null = null) {
  const accessToken = randomUUID()
  const id = await insertReturningId(env.db(), 'yggdrasil_tokens', {
    user_id: uid,
    player_id: pid,
    access_token_hash: sha256(accessToken),
    client_token: 'test-client',
    created_at: old,
    valid_until: future,
    expires_at: future,
  })
  return { id, accessToken }
}
async function selection(uid: number, pid: number) {
  const deviceCode = randomUUID()
  await env
    .db()
    .insertInto('device_code_selections')
    .values({ device_code: deviceCode, user_id: uid, player_id: pid, created_at: old })
    .execute()
  return deviceCode
}
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const operations = [
  {
    name: '改名',
    run: (actor: AdminActor, pid: number) => env.core.admin.updatePlayer(actor, pid, { name: `After${pid}` }),
  },
  { name: '换材质', run: (actor: AdminActor, pid: number) => env.core.admin.updatePlayer(actor, pid, { skin: null }) },
  { name: '转让', run: (actor: AdminActor, pid: number) => env.core.admin.transferPlayer(actor, pid, env.actor.uid) },
  { name: '删除', run: (actor: AdminActor, pid: number) => env.core.admin.deletePlayer(actor, pid) },
]

test.each(operations)('$name：没有角色管理权限时拒绝，角色、积分、审计、事件和邮件都不变', async ({ run }) => {
  await configureMail()
  const target = await player(env.owner.uid, 'Before', await env.texture())
  const banned = await env.user('banned')
  await role(banned.uid, 'banned')
  for (const actor of [
    { ...env.actor, ip: null },
    { ...banned, ip: null },
  ])
    await unchanged(() => run(actor, target.pid), 'permission_denied')
  deny('admin', 'players.manage')
  await unchanged(() => run(admin, target.pid), 'permission_denied')
})

test.each(operations)('$name：主人是自己、同级或更高身份时拒绝；角色不存在时也不留痕迹', async ({ run }) => {
  await configureMail()
  const peer = await env.user('peer')
  await role(peer.uid, 'admin')
  const skin = await env.texture()
  for (const [actor, uid] of [
    [admin, admin.uid],
    [admin, peer.uid],
    [admin, superadmin.uid],
    [superadmin, superadmin.uid],
  ] as const) {
    const target = await player(uid, `Player${uid}By${actor.uid}`, skin)
    await unchanged(() => run(actor, target.pid), 'user_not_manageable')
  }
  await unchanged(() => run(admin, missing), 'player_not_found')
  expect(await logs()).toEqual([])
  expect(await eventJobs()).toEqual([])
  expect(await notices()).toEqual([])
})

test.each(operations)('$name：超级管理员能管理管理员的角色，事件身份取数据库中的身份', async ({ run }) => {
  const target = await player(admin.uid, 'Before', await env.texture())
  await run(superadmin, target.pid)
  const emitted = await eventJobs()
  expect(emitted.length).toBeGreaterThan(0)
  for (const entry of emitted) expect(entry.actor).toEqual({ kind: 'user', uid: superadmin.uid, role: 'superadmin' })
  expect((await logs()).every((entry) => entry.actor_user_id === superadmin.uid)).toBe(true)
  expect(await notices()).toEqual([])
})

test.each(operations)('$name：主人被封禁或邮箱未验证不影响管理，管理员也不必验证邮箱', async ({ run }) => {
  await env.setting('auth.requireEmailVerification', true)
  await env.db().updateTable('users').set({ email_verified: false }).where('id', '=', admin.uid).execute()
  const skin = await env.texture()
  for (const value of ['banned', 'user'] as const) {
    await role(env.owner.uid, value)
    await env.db().updateTable('users').set({ email_verified: false }).where('id', '=', env.owner.uid).execute()
    const target = await player(env.owner.uid, `Before${value}`, skin)
    await run(admin, target.pid)
  }
  expect(await notices()).toEqual([])
})

test.each(operations)('$name：提交失败时业务、审计、事件、邮件和令牌清理一起回滚', async ({ run }) => {
  await configureMail()
  const target = await player(env.owner.uid, 'Before', await env.texture('steve', false))
  await launcherToken(env.owner.uid, target.pid)
  await selection(env.owner.uid, target.pid)
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
    await expect(run(admin, target.pid)).rejects.toThrow('模拟提交失败')
  } finally {
    spy.mockRestore()
  }
  expect(written).toBeGreaterThan(0)
  expect(await snapshot()).toEqual(before)
})

test('改名：不分大小写撞名按规范化名字拒绝，失败没有任何副作用', async () => {
  await configureMail()
  const target = await player()
  await player(env.actor.uid, 'Steve')
  for (const name of ['steve', 'STEVE', ' Steve '])
    await unchanged(() => env.core.admin.updatePlayer(admin, target.pid, { name }), 'player_name_taken')
})

test('改名：长度和官方、汉字、任意字符、自定义规则与用户侧相同', async () => {
  const target = await player()
  await env.setting('player.nameLength', { min: 3, max: 8 })
  await env.setting('player.nameRule', 'official')
  for (const name of ['', 'AB', 'A'.repeat(9)])
    await unchanged(() => env.core.admin.updatePlayer(admin, target.pid, { name }), 'player_name_length', {
      min: 3,
      max: 8,
    })
  for (const name of ['中名字', 'A B', 'A😀B'])
    await unchanged(() => env.core.admin.updatePlayer(admin, target.pid, { name }), 'player_name_invalid', {
      rule: 'official',
    })
  await env.setting('player.nameRule', 'cjk')
  expect(await env.core.admin.updatePlayer(admin, target.pid, { name: '  中名字§  ' })).toMatchObject({
    name: '中名字§',
  })
  await env.setting('player.nameRule', 'utf8')
  expect(await env.core.admin.updatePlayer(admin, target.pid, { name: '😀😀😀' })).toMatchObject({ name: '😀😀😀' })
  await unchanged(() => env.core.admin.updatePlayer(admin, target.pid, { name: 'A B' }), 'player_name_invalid', {
    rule: 'utf8',
  })
  await env.setting('player.nameRule', 'custom')
  await env.setting('player.nameRegex', '^Z[0-9]+$')
  await unchanged(() => env.core.admin.updatePlayer(admin, target.pid, { name: 'ABC' }), 'player_name_invalid', {
    rule: 'custom',
  })
  expect(await env.core.admin.updatePlayer(admin, target.pid, { name: 'Z123' })).toMatchObject({ name: 'Z123' })
})

test('改名：不扣积分、不改 UUID，管理员发事件和审计，通知主人现在的邮箱；同名不写入', async () => {
  await configureMail()
  await env.setting('score.perPlayer', 500)
  const target = await player()
  await env.db().updateTable('users').set({ email: 'current@example.test' }).where('id', '=', target.uid).execute()
  // actor 只带 uid 和 ip；提升后的身份须从数据库取。
  await role(admin.uid, 'superadmin')
  const balance = await env.balance(target.uid)
  env.tick()
  const changed = await env.core.admin.updatePlayer(admin, target.pid, { name: ' After ' })
  expect(changed).toEqual({ ...target, name: 'After', updatedAt: env.now() })
  expect(await row(target.pid)).toMatchObject({
    uuid: target.uuid,
    name_key: 'after',
    score_paid: 73,
    updated_at: env.now(),
  })
  expect(await env.balance(target.uid)).toBe(balance)
  expect(await env.ledger(target.uid)).toEqual([])
  expect(await env.events('player.renamed')).toMatchObject([
    {
      actor: { kind: 'user', uid: admin.uid, role: 'superadmin' },
      data: { player: changed, previousName: target.name },
    },
  ])
  const audit = await logs()
  expect(audit).toMatchObject([
    auditEntry('player.rename', target.uid, { pid: target.pid, uuid: target.uuid, from: target.name, to: 'After' }),
  ])
  expect(audit[0]!.details).toEqual({ pid: target.pid, uuid: target.uuid, from: target.name, to: 'After' })
  expect(await notices()).toEqual([
    {
      template: 'adminAccountChanged',
      uid: target.uid,
      to: 'current@example.test',
      changes: [{ kind: 'playerRenamed', from: target.name, to: 'After' }],
      at: env.now(),
    },
  ])
  const before = await snapshot(),
    writes = env.playerWrites
  env.tick()
  expect(await env.core.admin.updatePlayer(admin, target.pid, { name: ' After ' })).toEqual(changed)
  expect(env.playerWrites).toBe(writes)
  expect(await snapshot()).toEqual(before)
})

test('换材质：拒绝别人私有或不存在的材质，槽位类型错误带槽名；失败连带改名一起回滚', async () => {
  await configureMail()
  const target = await player(env.actor.uid)
  const hidden = await env.texture('steve', false),
    skin = await env.texture(),
    cape = await env.texture('cape')
  for (const tid of [hidden, missing])
    await unchanged(
      () => env.core.admin.updatePlayer(admin, target.pid, { name: 'After', skin: tid }),
      'texture_not_found',
    )
  await unchanged(
    () => env.core.admin.updatePlayer(admin, target.pid, { name: 'After', skin: cape }),
    'texture_type_mismatch',
    { slot: 'skin' },
  )
  await unchanged(
    () => env.core.admin.updatePlayer(admin, target.pid, { name: 'After', cape: skin }),
    'texture_type_mismatch',
    { slot: 'cape' },
  )
})

test('换材质：主人私有和公开材质无需衣柜，空值清空，事件带原槽位，审计只带改动槽且不发邮件', async () => {
  await configureMail()
  const oldSkin = await env.texture(),
    oldCape = await env.texture('cape')
  const target = await player(env.owner.uid, 'Before', oldSkin, oldCape)
  const privateSkin = await env.texture('alex', false),
    publicCape = await env.texture('cape')
  await env.db().updateTable('textures').set({ uploader_id: env.actor.uid }).where('id', '=', publicCape).execute()
  expect(await countRows(env.db().selectFrom('closet_items'))).toBe(0)
  env.tick()
  const changed = await env.core.admin.updatePlayer(admin, target.pid, { skin: privateSkin, cape: publicCape })
  expect(changed).toEqual({ ...target, skin: privateSkin, cape: publicCape, updatedAt: env.now() })
  expect(await env.events('player.texturesChanged')).toMatchObject([
    {
      actor: { kind: 'user', uid: admin.uid, role: 'admin' },
      data: { player: changed, previous: { skin: oldSkin, cape: oldCape } },
    },
  ])
  const details = {
    pid: target.pid,
    name: target.name,
    uuid: target.uuid,
    skin: { from: oldSkin, to: privateSkin },
    cape: { from: oldCape, to: publicCape },
  }
  expect(await logs()).toMatchObject([auditEntry('player.setTextures', target.uid, details)])
  expect((await logs())[0]!.details).toEqual(details)
  const before = await snapshot(),
    writes = env.playerWrites
  await env.core.admin.updatePlayer(admin, target.pid, { skin: privateSkin, cape: publicCape })
  expect(await snapshot()).toEqual(before)
  expect(env.playerWrites).toBe(writes)
  await env.core.admin.updatePlayer(admin, target.pid, { skin: null })
  expect((await logs())[1]!.details).toEqual({
    pid: target.pid,
    name: target.name,
    uuid: target.uuid,
    skin: { from: privateSkin, to: null },
  })
  await env.core.admin.updatePlayer(admin, target.pid, { cape: null })
  expect((await logs())[2]!.details).toEqual({
    pid: target.pid,
    name: target.name,
    uuid: target.uuid,
    cape: { from: publicCape, to: null },
  })
  expect(await row(target.pid)).toMatchObject({ skin_texture_id: null, cape_texture_id: null, uuid: target.uuid })
  expect((await env.events('player.texturesChanged')).map((entry) => entry.data.previous)).toEqual([
    { skin: oldSkin, cape: oldCape },
    { skin: privateSkin, cape: publicCape },
    { skin: null, cape: publicCape },
  ])
  expect(await notices()).toEqual([])
  expect(await env.ledger(target.uid)).toEqual([])
})

test('同时改名和换材质：两个事件使用相同的最终角色，各一条审计，只发一封改名邮件', async () => {
  await configureMail()
  const target = await player(),
    skin = await env.texture()
  env.tick()
  const changed = await env.core.admin.updatePlayer(admin, target.pid, { name: 'After', skin })
  const renamed = await env.events('player.renamed'),
    textured = await env.events('player.texturesChanged')
  expect(renamed).toHaveLength(1)
  expect(textured).toHaveLength(1)
  expect(renamed[0]!.data.player).toEqual(changed)
  expect(textured[0]!.data.player).toEqual(changed)
  expect(changed).toEqual({ ...target, name: 'After', skin, updatedAt: env.now() })
  expect((await logs()).map((entry) => [entry.action, entry.details])).toEqual([
    ['player.rename', { pid: target.pid, uuid: target.uuid, from: target.name, to: 'After' }],
    ['player.setTextures', { pid: target.pid, name: 'After', uuid: target.uuid, skin: { from: null, to: skin } }],
  ])
  expect(await notices()).toEqual([
    {
      template: 'adminAccountChanged',
      uid: target.uid,
      to: 'owner@example.test',
      changes: [{ kind: 'playerRenamed', from: target.name, to: 'After' }],
      at: env.now(),
    },
  ])
})

test('转让：新主人不存在、是自己、同级或更高身份时拒绝且全部不变', async () => {
  await configureMail()
  const peer = await env.user('peer')
  await role(peer.uid, 'admin')
  const target = await player()
  await unchanged(() => env.core.admin.transferPlayer(admin, target.pid, missing), 'user_not_found')
  for (const uid of [admin.uid, peer.uid, superadmin.uid])
    await unchanged(() => env.core.admin.transferPlayer(admin, target.pid, uid), 'user_not_manageable')
  await unchanged(() => env.core.admin.transferPlayer(superadmin, target.pid, superadmin.uid), 'user_not_manageable')
})

test('转让：新主人等于原主人时不写角色、不清令牌、不发事件、审计或邮件', async () => {
  await configureMail()
  const target = await player(env.owner.uid, 'Before', await env.texture('steve', false))
  await launcherToken(target.uid, target.pid)
  await selection(target.uid, target.pid)
  const before = await snapshot(),
    writes = env.playerWrites
  env.tick()
  expect(await env.core.admin.transferPlayer(admin, target.pid, target.uid)).toEqual(target)
  expect(await snapshot()).toEqual(before)
  expect(env.playerWrites).toBe(writes)
})

test('转让：清掉原主人和第三人的私有材质，清零实付、不退款；先换材质再转让，两个事件角色相同', async () => {
  await configureMail()
  const skin = await env.texture('steve', false),
    cape = await env.texture('cape', false)
  const third = await env.user('third')
  await env.db().updateTable('textures').set({ uploader_id: third.uid }).where('id', '=', cape).execute()
  const target = await player(env.owner.uid, 'Before', skin, cape)
  const other = await player(target.uid, 'Other')
  const bound = await launcherToken(target.uid, target.pid)
  const unbound = await launcherToken(target.uid)
  const otherToken = await launcherToken(target.uid, other.pid)
  const selected = await selection(target.uid, target.pid),
    otherSelected = await selection(target.uid, other.pid)
  await env.db().updateTable('users').set({ email: 'old-current@example.test' }).where('id', '=', target.uid).execute()
  await env
    .db()
    .updateTable('users')
    .set({ email: 'new-current@example.test', email_verified: false, role: 'banned' })
    .where('id', '=', env.actor.uid)
    .execute()
  env.tick()
  const changed = await env.core.admin.transferPlayer(admin, target.pid, env.actor.uid)
  expect(changed).toEqual({ ...target, uid: env.actor.uid, skin: null, cape: null, updatedAt: env.now() })
  expect(await row(target.pid)).toMatchObject({
    name: target.name,
    uuid: target.uuid,
    user_id: env.actor.uid,
    score_paid: 0,
    updated_at: env.now(),
  })
  expect(await env.balance(target.uid)).toBe(1000)
  expect(await env.balance(env.actor.uid)).toBe(1000)
  expect(await env.ledger(target.uid)).toEqual([])
  const emitted = await eventJobs()
  expect(emitted.map((entry) => entry.name)).toEqual(['player.texturesChanged', 'player.transferred'])
  expect(emitted.map((entry) => entry.data.player)).toEqual([changed, changed])
  expect(emitted).toMatchObject([
    { actor: { kind: 'user', uid: admin.uid, role: 'admin' }, data: { player: changed, previous: { skin, cape } } },
    { actor: { kind: 'user', uid: admin.uid, role: 'admin' }, data: { player: changed, previousUid: target.uid } },
  ])
  const details = {
    pid: target.pid,
    name: target.name,
    uuid: target.uuid,
    from: target.uid,
    to: env.actor.uid,
    scorePaid: 73,
    cleared: { skin, cape },
  }
  const audit = await logs()
  expect(audit).toMatchObject([
    auditEntry('player.transfer', target.uid, details),
    auditEntry('player.transfer', env.actor.uid, details),
  ])
  expect(audit.map((entry) => entry.details)).toEqual([details, details])
  const remaining = await env.db().selectFrom('yggdrasil_tokens').select('id').orderBy('id').execute()
  expect(remaining.map((entry) => entry.id)).toEqual([unbound.id, otherToken.id])
  expect(remaining.map((entry) => entry.id)).not.toContain(bound.id)
  expect(await env.db().selectFrom('device_code_selections').select('device_code').execute()).toEqual([
    { device_code: otherSelected },
  ])
  expect(otherSelected).not.toBe(selected)
  expect(await notices()).toEqual([
    {
      template: 'adminAccountChanged',
      uid: target.uid,
      to: 'old-current@example.test',
      changes: [{ kind: 'playerTransferredOut', name: target.name }],
      at: env.now(),
    },
    {
      template: 'adminAccountChanged',
      uid: env.actor.uid,
      to: 'new-current@example.test',
      changes: [{ kind: 'playerTransferredIn', name: target.name }],
      at: env.now(),
    },
  ])
})

test.each(['skin', 'cape'] as const)('转让：只清掉 $0 槽时审计只列该槽，另一个公开槽保留', async (slot) => {
  const skin = await env.texture('steve', slot !== 'skin'),
    cape = await env.texture('cape', slot !== 'cape')
  const target = await player(env.owner.uid, 'Before', skin, cape)
  const changed = await env.core.admin.transferPlayer(admin, target.pid, env.actor.uid)
  expect(changed).toMatchObject({
    uid: env.actor.uid,
    skin: slot === 'skin' ? null : skin,
    cape: slot === 'cape' ? null : cape,
  })
  expect((await logs()).map((entry) => entry.details.cleared)).toEqual([
    { [slot]: slot === 'skin' ? skin : cape },
    { [slot]: slot === 'skin' ? skin : cape },
  ])
  const emitted = await eventJobs()
  expect(emitted.map((entry) => entry.name)).toEqual(['player.texturesChanged', 'player.transferred'])
  expect((await env.events('player.texturesChanged'))[0]!.data.player).toEqual(changed)
  expect((await env.events('player.transferred'))[0]!.data.player).toEqual(changed)
})

test.each(['公开皮肤和新主人私有披风', '新主人私有皮肤和公开披风', '空槽'])(
  '转让：保留%s，只发转让事件',
  async (state) => {
    const skin = state === '空槽' ? null : await env.texture('steve', state === '公开皮肤和新主人私有披风')
    const cape = state === '空槽' ? null : await env.texture('cape', state !== '公开皮肤和新主人私有披风')
    for (const tid of [skin, cape])
      if (tid !== null)
        await env
          .db()
          .updateTable('textures')
          .set({ uploader_id: env.actor.uid })
          .where('id', '=', tid)
          .where('is_public', '=', 0)
          .execute()
    const target = await player(env.owner.uid, 'Before', skin, cape)
    const changed = await env.core.admin.transferPlayer(admin, target.pid, env.actor.uid)
    expect(changed).toMatchObject({ name: target.name, uuid: target.uuid, uid: env.actor.uid, skin, cape })
    expect((await eventJobs()).map((entry) => entry.name)).toEqual(['player.transferred'])
    expect(await env.events('player.transferred')).toMatchObject([
      { data: { player: changed, previousUid: target.uid } },
    ])
    expect((await logs()).map((entry) => entry.details.cleared)).toEqual([{}, {}])
    expect(await notices()).toEqual([])
  },
)

test('删除：即使开启退款也不退实付，管理员发删除事件和审计，级联清令牌和设备选择，通知主人', async () => {
  await configureMail()
  await env.setting('score.refundOnDelete', true)
  const target = await player(),
    other = await player(target.uid, 'Other')
  await launcherToken(target.uid, target.pid)
  const retained = await launcherToken(target.uid, other.pid)
  await selection(target.uid, target.pid)
  await env.db().updateTable('users').set({ email: 'current@example.test' }).where('id', '=', target.uid).execute()
  env.tick()
  await env.core.admin.deletePlayer(admin, target.pid)
  expect(await row(target.pid)).toBeUndefined()
  expect(await env.balance(target.uid)).toBe(1000)
  expect(await env.ledger(target.uid)).toEqual([])
  expect(await eventJobs()).toMatchObject([
    {
      name: 'player.deleted',
      actor: { kind: 'user', uid: admin.uid, role: 'admin' },
      data: { pid: target.pid, uid: target.uid, name: target.name, uuid: target.uuid },
    },
  ])
  expect(await eventJobs()).toHaveLength(1)
  const details = { pid: target.pid, name: target.name, uuid: target.uuid, scorePaid: 73 }
  expect(await logs()).toMatchObject([auditEntry('player.delete', target.uid, details)])
  expect((await logs())[0]!.details).toEqual(details)
  expect(await env.db().selectFrom('yggdrasil_tokens').select('id').execute()).toEqual([{ id: retained.id }])
  expect(await env.db().selectFrom('device_code_selections').selectAll().execute()).toEqual([])
  expect(await notices()).toEqual([
    {
      template: 'adminAccountChanged',
      uid: target.uid,
      to: 'current@example.test',
      changes: [{ kind: 'playerDeleted', name: target.name }],
      at: env.now(),
    },
  ])
})

test.each(['转让先提交', '删除先提交'])('并发转让与主人自行删除：%s，最终只能已删除或属于新主人', async (order) => {
  const target = await player()
  const transfer = () => env.core.admin.transferPlayer(admin, target.pid, env.actor.uid)
  const remove = () => env.core.players.delete({ uid: target.uid }, target.pid)
  const pause = env.pauseNextCommit()
  const leading = (order === '转让先提交' ? transfer() : remove()).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  )
  let trailing: typeof leading | undefined
  try {
    await pause.entered
    trailing = (order === '转让先提交' ? remove() : transfer()).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    await Promise.race([pause.contended, delay(200)])
    pause.resume()
    expect(await leading).toHaveProperty('value')
    // 落后的请求必须重新核对主人，不能变成数据库异常或误删转走的角色。
    expect(await trailing).toMatchObject({ error: { code: 'player_not_found' } })
    const final = await row(target.pid)
    if (order === '转让先提交') expect(final).toMatchObject({ user_id: env.actor.uid, uuid: target.uuid })
    else expect(final).toBeUndefined()
  } finally {
    pause.resume()
    await leading
    await trailing
    pause.restore()
  }
})

test('并发刷新：事务外确认归属后转让先提交，锁内重读拒绝给原主人绑定角色', async () => {
  const target = await player()
  const token = await launcherToken(target.uid)
  const transaction = env.db().transaction.bind(env.db())
  let interleaved = false
  // refresh 已读完 selectedProfile 的归属才会创建事务。在真正进入事务前提交转让，四种库都能稳定复现同一空当；
  // 转让的事务不经过这个一次性的替身，也不在刷新持有的连接里启动嵌套事务（SQLite 只有一个写连接）。
  const spy = vi.spyOn(env.db(), 'transaction').mockImplementationOnce(() => {
    const builder = transaction(),
      execute = builder.execute.bind(builder)
    builder.execute = async <T>(callback: (tx: Transaction<CoreDatabase>) => Promise<T>) => {
      expect(await row(target.pid)).toMatchObject({ user_id: target.uid })
      await env.core.admin.transferPlayer(admin, target.pid, env.actor.uid)
      expect(await row(target.pid)).toMatchObject({ user_id: env.actor.uid })
      interleaved = true
      return execute(callback)
    }
    return builder
  })
  try {
    const result = await env.core.yggdrasil
      .refresh({
        accessToken: token.accessToken,
        clientToken: 'test-client',
        requestUser: false,
        selectedProfile: { id: target.uuid, name: target.name },
      })
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
    expect(interleaved).toBe(true)
    expect(
      await countRows(
        env.db().selectFrom('yggdrasil_tokens').where('user_id', '=', target.uid).where('player_id', '=', target.pid),
      ),
    ).toBe(0)
    expect(result).toMatchObject({
      error: { kind: 'ForbiddenOperationException', messageKey: 'yggdrasil.errors.profile_not_owned' },
    })
    // 刷新失败整体回滚，原来的未绑定令牌仍在；转让自己的两条审计和事件已经提交。
    expect(await env.db().selectFrom('yggdrasil_tokens').select(['id', 'player_id']).execute()).toEqual([
      { id: token.id, player_id: null },
    ])
    expect((await logs()).map((entry) => entry.action)).toEqual(['player.transfer', 'player.transfer'])
  } finally {
    spy.mockRestore()
  }
})

test('角色列表：必须有角色管理权限', async () => {
  await expect(env.core.admin.listPlayers(env.actor.uid, { page: 1 })).rejects.toMatchObject({
    code: 'permission_denied',
  })
  deny('admin', 'players.manage')
  await expect(env.core.admin.listPlayers(admin.uid, { page: 1 })).rejects.toMatchObject({ code: 'permission_denied' })
})

test('角色列表：名字不分大小写包含匹配，字面通配符不扩大匹配；UUID 带连字符、不带和大写都精确匹配', async () => {
  const first = await player(env.owner.uid, 'PreStevePost'),
    second = await player(env.actor.uid, 'sTEVe'),
    other = await player(env.owner.uid, 'Alex')
  const query = (q: string) => env.core.admin.listPlayers(admin.uid, { page: 1, q })
  expect((await query('sTeV')).items.map((entry) => entry.pid)).toEqual([second.pid, first.pid])
  expect((await query('Alex')).items.map((entry) => entry.pid)).toEqual([other.pid])
  expect(await query('%')).toMatchObject({ total: 0, items: [] })
  await player(env.owner.uid, 'With_Underscore')
  expect((await query('_')).items.map((entry) => entry.name)).toEqual(['With_Underscore'])
  const dashed = first.uuid.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')
  for (const q of [first.uuid, first.uuid.toUpperCase(), dashed, dashed.toUpperCase()]) {
    const result = await query(q)
    expect(result.total).toBe(1)
    expect(result.items.map((entry) => entry.pid)).toEqual([first.pid])
  }
  expect(await query(first.uuid.slice(0, 20))).toMatchObject({ total: 0, items: [] })
})

test('角色列表：主人筛选和摘要、皮肤披风、倒序分页和总数；不存在的主人返回空摘要', async () => {
  const skin = await env.texture('alex', false),
    cape = await env.texture('cape')
  const first = await player(env.owner.uid, 'First', skin, cape),
    second = await player(env.owner.uid, 'Second')
  const third = await player(env.actor.uid, 'Third')
  const skinRow = await env.db().selectFrom('textures').select('hash').where('id', '=', skin).executeTakeFirstOrThrow()
  const capeRow = await env.db().selectFrom('textures').select('hash').where('id', '=', cape).executeTakeFirstOrThrow()
  const page = await env.core.admin.listPlayers(admin.uid, { page: 1, perPage: 2 })
  expect(page.total).toBe(3)
  expect(page.items.map((entry) => entry.pid)).toEqual([third.pid, second.pid])
  const last = await env.core.admin.listPlayers(admin.uid, { page: 2, perPage: 2 })
  expect(last.total).toBe(3)
  expect(last.items).toMatchObject([
    {
      pid: first.pid,
      name: first.name,
      uuid: first.uuid,
      updatedAt: old,
      owner: { uid: env.owner.uid, nickname: 'owner', role: 'user' },
      skin: { tid: skin, hash: skinRow.hash, type: 'alex', scale: 1 },
      cape: { tid: cape, hash: capeRow.hash, scale: 1 },
    },
  ])
  expect(page.items.every((entry) => entry.skin === null && entry.cape === null)).toBe(true)
  const owned = await env.core.admin.listPlayers(admin.uid, { page: 1, owner: env.owner.uid })
  expect(owned.owner).toEqual({ uid: env.owner.uid, nickname: 'owner' })
  expect(owned.total).toBe(2)
  expect(owned.items.map((entry) => entry.pid)).toEqual([second.pid, first.pid])
  expect(owned.items.every((entry) => entry.owner.uid === env.owner.uid && entry.owner.role === 'user')).toBe(true)
  expect(await env.core.admin.listPlayers(admin.uid, { page: 1, owner: env.owner.uid, q: 'Second' })).toMatchObject({
    total: 1,
    items: [{ pid: second.pid }],
  })
  expect(await env.core.admin.listPlayers(admin.uid, { page: 1, owner: missing })).toEqual({
    total: 0,
    items: [],
    owner: null,
  })
})

test('角色列表：没有 textures.manage 时别人的私有材质只给出 tid，公开材质和自己的私有材质照常给预览', async () => {
  const hidden = await env.texture('steve', false),
    own = await env.texture('cape', false)
  await env.db().updateTable('textures').set({ uploader_id: admin.uid }).where('id', '=', own).execute()
  const visible = await env.texture('steve')
  const first = await player(env.owner.uid, 'First', hidden, own),
    second = await player(env.owner.uid, 'Second', visible)
  const list = async () =>
    Object.fromEntries(
      (await env.core.admin.listPlayers(admin.uid, { page: 1 })).items.map((entry) => [entry.pid, entry]),
    )
  expect((await list())[first.pid]).toMatchObject({
    skin: { tid: hidden, type: 'steve', scale: 1 },
    cape: { tid: own, scale: 1 },
  })
  deny('admin', 'textures.manage')
  const items = await list()
  expect(items[first.pid]?.skin).toEqual({ tid: hidden, hidden: true })
  expect(items[first.pid]?.cape).toMatchObject({ tid: own, scale: 1 })
  expect(items[second.pid]?.skin).toMatchObject({ tid: visible, type: 'steve', scale: 1 })
})

test('角色列表：默认每页五十行，越界页仍返回总数', async () => {
  for (let i = 0; i < 51; i++) await player(env.owner.uid, `Player${i}`)
  const first = await env.core.admin.listPlayers(admin.uid, { page: 1 })
  expect(first.total).toBe(51)
  expect(first.items).toHaveLength(50)
  const second = await env.core.admin.listPlayers(admin.uid, { page: 2 })
  expect(second.total).toBe(51)
  expect(second.items.map((entry) => entry.name)).toEqual(['Player0'])
  expect(await env.core.admin.listPlayers(admin.uid, { page: 3 })).toMatchObject({ total: 51, items: [] })
})

test('查用户：必须有角色管理权限，按编号和忽略大小写的完整邮箱精确查找', async () => {
  const expected = { uid: env.owner.uid, nickname: 'owner', email: 'owner@example.test', role: 'user', avatar: null }
  expect(await env.core.admin.lookupUser(admin.uid, String(env.owner.uid))).toEqual(expected)
  expect(await env.core.admin.lookupUser(admin.uid, 'OWNER@EXAMPLE.TEST')).toEqual(expected)
  for (const q of ['owner@', 'owner', String(missing)])
    await expect(env.core.admin.lookupUser(admin.uid, q)).rejects.toMatchObject({ code: 'user_not_found' })
  await expect(env.core.admin.lookupUser(env.actor.uid, String(env.owner.uid))).rejects.toMatchObject({
    code: 'permission_denied',
  })
  deny('admin', 'players.manage')
  await expect(env.core.admin.lookupUser(admin.uid, String(env.owner.uid))).rejects.toMatchObject({
    code: 'permission_denied',
  })
})

test('查用户：自己、同级和更高身份全部隐藏，超级管理员可以查管理员', async () => {
  const peer = await env.user('peer')
  await role(peer.uid, 'admin')
  for (const [viewer, uid, email] of [
    [admin.uid, admin.uid, 'admin@example.test'],
    [admin.uid, peer.uid, 'peer@example.test'],
    [admin.uid, superadmin.uid, 'superadmin@example.test'],
    [superadmin.uid, superadmin.uid, 'superadmin@example.test'],
  ] as const)
    for (const q of [String(uid), email])
      await expect(env.core.admin.lookupUser(viewer, q)).rejects.toMatchObject({ code: 'user_not_found' })
  expect(await env.core.admin.lookupUser(superadmin.uid, String(admin.uid))).toMatchObject({
    uid: admin.uid,
    role: 'admin',
  })
})

test('查用户：没有封禁权限时邮箱不能探测，编号可查但不返回邮箱', async () => {
  deny('admin', 'users.ban')
  for (const q of ['owner@example.test', 'OWNER@EXAMPLE.TEST'])
    await expect(env.core.admin.lookupUser(admin.uid, q)).rejects.toMatchObject({ code: 'user_not_found' })
  expect(await env.core.admin.lookupUser(admin.uid, String(env.owner.uid))).toEqual({
    uid: env.owner.uid,
    nickname: 'owner',
    email: null,
    role: 'user',
    avatar: null,
  })
})

test('查材质：角色管理或用户管理任一权限足够，两项都没有则拒绝', async () => {
  const tid = await env.texture()
  await expect(env.core.admin.textureForOwner(env.actor.uid, tid, env.owner.uid)).rejects.toMatchObject({
    code: 'permission_denied',
  })
  for (const permission of ['players.manage', 'users.manage'] as const) {
    deny('admin', permission)
    expect(await env.core.admin.textureForOwner(admin.uid, tid, env.owner.uid)).toMatchObject({
      tid,
      visibleToOwner: true,
    })
  }
  vi.mocked(can).mockImplementation(
    (r, p) => !(r === 'admin' && (p === 'players.manage' || p === 'users.manage')) && permissions.can(r, p),
  )
  await expect(env.core.admin.textureForOwner(admin.uid, tid, env.owner.uid)).rejects.toMatchObject({
    code: 'permission_denied',
  })
})

test('查材质：主人不存在、不能管理主人和材质不存在按各自错误返回', async () => {
  const tid = await env.texture(),
    peer = await env.user('peer')
  await role(peer.uid, 'admin')
  await expect(env.core.admin.textureForOwner(admin.uid, tid, missing)).rejects.toMatchObject({
    code: 'user_not_found',
  })
  for (const uid of [admin.uid, peer.uid, superadmin.uid])
    await expect(env.core.admin.textureForOwner(admin.uid, tid, uid)).rejects.toMatchObject({
      code: 'user_not_manageable',
    })
  await expect(env.core.admin.textureForOwner(admin.uid, missing, env.owner.uid)).rejects.toMatchObject({
    code: 'texture_not_found',
  })
  expect(await env.core.admin.textureForOwner(superadmin.uid, tid, admin.uid)).toMatchObject({ tid })
})

test('查材质：公开、主人自己的私有材质可见，别人的私有不可见；缺少材质管理权限时隐藏完整字段', async () => {
  const publicTid = await env.texture(),
    ownTid = await env.texture('alex', false),
    hiddenTid = await env.texture('cape', false)
  await env.db().updateTable('textures').set({ uploader_id: env.actor.uid }).where('id', '=', hiddenTid).execute()
  for (const [tid, visibleToOwner] of [
    [publicTid, true],
    [ownTid, true],
    [hiddenTid, false],
  ] as const) {
    const texture = await env.db().selectFrom('textures').selectAll().where('id', '=', tid).executeTakeFirstOrThrow()
    expect(await env.core.admin.textureForOwner(admin.uid, tid, env.owner.uid)).toEqual({
      tid,
      name: texture.name,
      type: texture.type,
      public: texture.is_public === 1,
      uploaderId: texture.uploader_id,
      hash: texture.hash,
      scale: 1,
      visibleToOwner,
    })
  }
  deny('admin', 'textures.manage')
  expect(await env.core.admin.textureForOwner(admin.uid, hiddenTid, env.owner.uid)).toEqual({
    tid: hiddenTid,
    public: false,
    visibleToOwner: false,
  })
  expect(await env.core.admin.textureForOwner(admin.uid, ownTid, env.owner.uid)).toEqual({
    tid: ownTid,
    public: false,
    visibleToOwner: true,
  })
  expect(await env.core.admin.textureForOwner(admin.uid, publicTid, env.owner.uid)).toMatchObject({
    tid: publicTid,
    name: 'Texture',
    public: true,
    visibleToOwner: true,
  })
})
