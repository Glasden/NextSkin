/**
 * ADR-0036 切片三的后台衣柜请求：逐入口权限、主人等级、免费加入、按实付移出、角色清理、隐藏项和分页。
 * 经 core 调用完整用例，失败同时比较业务状态、流水、审计和事件；四库共用，不绕过领域规则。
 */
import { randomUUID } from 'node:crypto'
import { insertReturningId, type UserRole } from '@nextskin/db'
import { beforeEach, expect, test, vi } from 'vitest'
import { can, type CorePermission } from '../access/permissions.ts'
import * as auditModule from '../audit/write.ts'
import { old, setup } from '../closet/test-support.ts'
import type { AdminActor } from './types.ts'

vi.mock('../access/permissions.ts', { spy: true })
const permissions = await vi.importActual<typeof import('../access/permissions.ts')>('../access/permissions.ts')
const env = setup()
let admin: AdminActor, superadmin: AdminActor

beforeEach(async () => {
  vi.mocked(can).mockImplementation(permissions.can)
  await env.db().deleteFrom('audit_logs').execute()
  admin = { ...(await env.user('admin')), ip: '2001:db8::36' }
  superadmin = { ...(await env.user('superadmin')), ip: '192.0.2.36' }
  await role(admin.uid, 'admin')
  await role(superadmin.uid, 'superadmin')
  env.subscribe('closet.itemAdded', 'closet.itemRemoved', 'player.texturesChanged', 'user.profileUpdated')
})

function deny(value: UserRole, permission: CorePermission) {
  vi.mocked(can).mockImplementation((r, p) => !(r === value && p === permission) && permissions.can(r, p))
}
async function role(uid: number, value: UserRole) {
  await env.db().updateTable('users').set({ role: value }).where('id', '=', uid).execute()
}
async function logs() {
  return (await env.db().selectFrom('audit_logs').selectAll().orderBy('id').execute()).map((entry) => ({
    ...entry,
    details: JSON.parse(entry.details) as Record<string, unknown>,
  }))
}
async function snapshot() {
  return {
    users: await env.db().selectFrom('users').selectAll().orderBy('id').execute(),
    textures: await env.db().selectFrom('textures').selectAll().orderBy('id').execute(),
    closet: await env.db().selectFrom('closet_items').selectAll().orderBy('user_id').orderBy('texture_id').execute(),
    players: await env.db().selectFrom('players').selectAll().orderBy('id').execute(),
    score: await env.db().selectFrom('score_transactions').selectAll().orderBy('id').execute(),
    audit: await logs(),
    jobs: await env.db().selectFrom('jobs').selectAll().orderBy('id').execute(),
  }
}
async function unchanged(run: () => Promise<unknown>, code: string) {
  const before = await snapshot()
  await expect(run()).rejects.toMatchObject({ code })
  expect(await snapshot()).toEqual(before)
}
function auditEntry(action: string, uid: number, details: Record<string, unknown>) {
  return {
    action,
    actor_type: 'user',
    actor_user_id: admin.uid,
    subject_type: 'user',
    subject_id: uid,
    ip: admin.ip,
    created_at: env.now(),
    details,
  }
}
/** 导入遗留衣柜项：实付不等于现价，也允许主人看不到。 */
async function legacyItem(uid: number, tid: number, paid = 73, name = '旧衣柜名') {
  await env
    .db()
    .insertInto('closet_items')
    .values({ user_id: uid, texture_id: tid, name, score_paid: paid, created_at: old })
    .execute()
  await env
    .db()
    .updateTable('textures')
    .set((eb) => ({ likes: eb('likes', '+', 1) }))
    .where('id', '=', tid)
    .execute()
}
async function player(uid: number, tid: number) {
  return insertReturningId(env.db(), 'players', {
    user_id: uid,
    name: `Player${uid}`,
    name_key: `player${uid}`,
    uuid: randomUUID().replaceAll('-', ''),
    skin_texture_id: tid,
    cape_texture_id: tid,
    created_at: old,
    updated_at: old,
  })
}
const operations = [
  {
    name: '加入',
    run: (actor: AdminActor, uid: number, tid: number) => env.core.admin.addClosetItem(actor, uid, { tid }),
  },
  {
    name: '移出',
    run: (actor: AdminActor, uid: number, tid: number) => env.core.admin.removeClosetItem(actor, uid, tid),
  },
]

test.each(operations)('$name：普通用户、封禁用户及缺少 users.manage 的管理员被拒绝且没有副作用', async ({ run }) => {
  const tid = await env.texture()
  await legacyItem(env.owner.uid, tid)
  const banned = await env.user('banned')
  await role(banned.uid, 'banned')
  for (const actor of [
    { ...env.actor, ip: null },
    { ...banned, ip: null },
  ])
    await unchanged(() => run(actor, env.owner.uid, tid), 'permission_denied')
  deny('admin', 'users.manage')
  await unchanged(() => run(admin, env.owner.uid, tid), 'permission_denied')
})

test.each(operations)('$name：自己、同级管理员、超级管理员不可管理；不存在的主人也不写入', async ({ run }) => {
  const peer = await env.user('peer')
  await role(peer.uid, 'admin')
  const tid = await env.texture()
  for (const uid of [admin.uid, peer.uid, superadmin.uid]) await legacyItem(uid, tid)
  for (const [actor, uid] of [
    [admin, admin.uid],
    [admin, peer.uid],
    [admin, superadmin.uid],
    [superadmin, superadmin.uid],
  ] as const) {
    await unchanged(() => run(actor, uid, tid), 'user_not_manageable')
  }
  await unchanged(() => run(admin, 2147483647, tid), 'user_not_found')
})

test.each(operations)('$name：超级管理员可以管理管理员的衣柜，事件身份来自数据库', async ({ name, run }) => {
  const tid = await env.texture()
  if (name === '移出') await legacyItem(admin.uid, tid)
  await run(superadmin, admin.uid, tid)
  expect(await env.events(name === '加入' ? 'closet.itemAdded' : 'closet.itemRemoved')).toEqual([
    expect.objectContaining({
      actor: { kind: 'user', uid: superadmin.uid, role: 'superadmin' },
      data: { uid: admin.uid, tid },
    }),
  ])
  expect(await logs()).toMatchObject([{ actor_user_id: superadmin.uid, subject_id: admin.uid }])
})

test.each([undefined, '管理员起的名字'])('加入：名字 %s，免费、实付零、收藏加一，审计和事件属于主人', async (name) => {
  await env.setting('score.perClosetItem', 9999)
  const tid = await env.texture('steve', false, '材质原名')
  const balances = [await env.balance(env.owner.uid), await env.balance(admin.uid)]
  env.tick()
  const item = await env.core.admin.addClosetItem(admin, env.owner.uid, { tid, name })
  const expectedName = name ?? '材质原名'
  const { hash } = await env.db().selectFrom('textures').select('hash').where('id', '=', tid).executeTakeFirstOrThrow()
  expect(item).toEqual({
    tid,
    name: expectedName,
    scorePaid: 0,
    addedAt: env.now(),
    visibleToOwner: true,
    texture: {
      name: '材质原名',
      type: 'steve',
      hash,
      scale: 1,
      public: false,
    },
  })
  expect(await env.db().selectFrom('closet_items').selectAll().execute()).toMatchObject([
    { user_id: env.owner.uid, texture_id: tid, name: expectedName, score_paid: 0 },
  ])
  expect([await env.balance(env.owner.uid), await env.balance(admin.uid)]).toEqual(balances)
  expect(await env.ledger(env.owner.uid)).toEqual([])
  expect(await env.ledger(admin.uid)).toEqual([])
  expect(await env.db().selectFrom('textures').select('likes').where('id', '=', tid).executeTakeFirstOrThrow()).toEqual(
    { likes: 1 },
  )
  expect(await logs()).toMatchObject([
    auditEntry('closet.add', env.owner.uid, { nickname: 'owner', tid, name: expectedName }),
  ])
  expect((await logs())[0]!.details).toEqual({ nickname: 'owner', tid, name: expectedName })
  expect(await env.events('closet.itemAdded')).toEqual([
    expect.objectContaining({
      actor: { kind: 'user', uid: admin.uid, role: 'admin' },
      data: { uid: env.owner.uid, tid },
    }),
  ])
  await env.setting('score.refundOnDelete', true)
  expect(await env.core.admin.removeClosetItem(admin, env.owner.uid, tid)).toEqual({ refunded: 0 })
  expect(await env.balance(env.owner.uid)).toBe(balances[0])
  await env.consistent(tid)
})

test('加入：主人自己的私有材质对没有 textures.manage 的操作者也是别人的私有材质，响应不给衣柜名和材质', async () => {
  const own = await env.texture('steve', false, '主人的私藏'),
    shared = await env.texture('steve', true, '公开的')
  deny('admin', 'textures.manage')
  expect(await env.core.admin.addClosetItem(admin, env.owner.uid, { tid: own })).toEqual({
    tid: own,
    name: null,
    scorePaid: 0,
    addedAt: env.now(),
    visibleToOwner: true,
    texture: null,
  })
  expect(await env.core.admin.addClosetItem(admin, env.owner.uid, { tid: shared })).toMatchObject({
    name: '公开的',
    texture: { name: '公开的', public: true },
  })
  expect(await env.db().selectFrom('closet_items').select('name').where('texture_id', '=', own).execute()).toEqual([
    { name: '主人的私藏' },
  ])
})

test('加入：主人不可见和重复的错误码同用户路径，失败不改收藏、积分、审计和事件', async () => {
  const hidden = await env.texture('steve', false)
  await env.db().updateTable('textures').set({ uploader_id: env.actor.uid }).where('id', '=', hidden).execute()
  for (const tid of [hidden, 2147483647]) {
    await unchanged(() => env.core.closet.add(env.owner, { tid }), 'texture_not_found')
    await unchanged(() => env.core.admin.addClosetItem(admin, env.owner.uid, { tid }), 'texture_not_found')
  }
  const tid = await env.texture()
  await env.core.admin.addClosetItem(admin, env.owner.uid, { tid })
  await unchanged(() => env.core.closet.add(env.owner, { tid }), 'closet_item_exists')
  await unchanged(() => env.core.admin.addClosetItem(admin, env.owner.uid, { tid }), 'closet_item_exists')
  await env.consistent(tid)
})

test.each([true, false])('移出：退款开关 %s，按该件实付退款，清理主人两个槽而保留头像和别人的角色', async (refund) => {
  await env.setting('score.refundOnDelete', refund)
  await env.setting('score.perClosetItem', 9999)
  const tid = await env.texture()
  await legacyItem(env.owner.uid, tid)
  await legacyItem(env.actor.uid, tid, 19)
  const pid = await player(env.owner.uid, tid),
    other = await player(env.actor.uid, tid)
  await env.db().updateTable('users').set({ avatar_texture_id: tid }).where('id', '=', env.owner.uid).execute()
  const balance = await env.balance(env.owner.uid)
  env.tick()
  const refunded = refund ? 73 : 0
  expect(await env.core.admin.removeClosetItem(admin, env.owner.uid, tid)).toEqual({ refunded })
  expect(await env.balance(env.owner.uid)).toBe(balance + refunded)
  expect(await env.ledger(env.owner.uid)).toEqual(
    refund
      ? [
          expect.objectContaining({
            delta: 73,
            reason: 'score.reasons.closetItemRemoved',
            subject_type: 'texture',
            subject_id: tid,
          }),
        ]
      : [],
  )
  expect(
    await env.db().selectFrom('players').selectAll().where('id', '=', pid).executeTakeFirstOrThrow(),
  ).toMatchObject({ skin_texture_id: null, cape_texture_id: null, updated_at: env.now() })
  expect(
    await env.db().selectFrom('players').selectAll().where('id', '=', other).executeTakeFirstOrThrow(),
  ).toMatchObject({ skin_texture_id: tid, cape_texture_id: tid, updated_at: old })
  expect(
    await env
      .db()
      .selectFrom('users')
      .select('avatar_texture_id')
      .where('id', '=', env.owner.uid)
      .executeTakeFirstOrThrow(),
  ).toEqual({ avatar_texture_id: tid })
  expect(await env.db().selectFrom('textures').select('likes').where('id', '=', tid).executeTakeFirstOrThrow()).toEqual(
    { likes: 1 },
  )
  expect(await logs()).toMatchObject([
    auditEntry('closet.remove', env.owner.uid, { nickname: 'owner', tid, name: '旧衣柜名', refunded }),
  ])
  expect((await logs())[0]!.details).toEqual({ nickname: 'owner', tid, name: '旧衣柜名', refunded })
  expect(await env.events('closet.itemRemoved')).toEqual([
    expect.objectContaining({
      actor: { kind: 'user', uid: admin.uid, role: 'admin' },
      data: { uid: env.owner.uid, tid },
    }),
  ])
  expect(await env.events('player.texturesChanged')).toMatchObject([
    {
      data: {
        player: { pid, uid: env.owner.uid, skin: null, cape: null },
        previous: { skin: tid, cape: tid },
      },
    },
  ])
  expect(await env.events('user.profileUpdated')).toEqual([])
  await env.consistent(tid)
  await unchanged(() => env.core.admin.removeClosetItem(admin, env.owner.uid, tid), 'closet_item_not_found')
})

test('移出：主人看不见的导入遗留私有项也可以清理并退款', async () => {
  await env.setting('score.refundOnDelete', true)
  const tid = await env.texture('steve', false)
  await env.db().updateTable('textures').set({ uploader_id: env.actor.uid }).where('id', '=', tid).execute()
  await legacyItem(env.owner.uid, tid)
  const pid = await player(env.owner.uid, tid)
  const balance = await env.balance(env.owner.uid)
  expect(await env.core.admin.removeClosetItem(admin, env.owner.uid, tid)).toEqual({ refunded: 73 })
  expect(await env.balance(env.owner.uid)).toBe(balance + 73)
  expect(
    await env.db().selectFrom('players').selectAll().where('id', '=', pid).executeTakeFirstOrThrow(),
  ).toMatchObject({ skin_texture_id: null, cape_texture_id: null })
  await env.consistent(tid)
})

test.each(operations)('$name：审计失败时衣柜、收藏数、退款、角色和事件整体回滚', async ({ name, run }) => {
  const tid = await env.texture()
  if (name === '移出') {
    await legacyItem(env.owner.uid, tid)
    await player(env.owner.uid, tid)
  }
  const before = await snapshot()
  const spy = vi.spyOn(auditModule, 'audit').mockRejectedValueOnce(new Error('模拟审计失败'))
  try {
    await expect(run(admin, env.owner.uid, tid)).rejects.toThrow('模拟审计失败')
    expect(spy).toHaveBeenCalledTimes(1)
  } finally {
    spy.mockRestore()
  }
  expect(await snapshot()).toEqual(before)
})

test('列表：逐入口要求 users.ban，普通用户和单独缺少权限的管理员都拒绝', async () => {
  await expect(env.core.admin.listCloset(env.actor.uid, env.owner.uid, { page: 1 })).rejects.toMatchObject({
    code: 'permission_denied',
  })
  deny('admin', 'users.ban')
  await expect(env.core.admin.listCloset(admin.uid, env.owner.uid, { page: 1 })).rejects.toMatchObject({
    code: 'permission_denied',
  })
})

test('列表：私有项预览受 textures.manage 控制，主人可见性独立判断，包含隐藏项并分页', async () => {
  const publicTid = await env.texture(),
    own = await env.texture('alex', false),
    hidden = await env.texture('cape', false)
  await env.db().updateTable('textures').set({ uploader_id: env.actor.uid }).where('id', '=', hidden).execute()
  for (const tid of [publicTid, own, hidden]) await legacyItem(env.owner.uid, tid)
  await legacyItem(env.actor.uid, await env.texture())
  const first = await env.core.admin.listCloset(admin.uid, env.owner.uid, { page: 1, perPage: 2 })
  expect(first.total).toBe(3)
  expect(first.items.map((item) => item.tid)).toEqual([hidden, own])
  expect(first.items).toMatchObject([
    { tid: hidden, visibleToOwner: false, texture: { name: 'Texture', type: 'cape', public: false, scale: 1 } },
    { tid: own, visibleToOwner: true, texture: { name: 'Texture', type: 'alex', public: false, scale: 1 } },
  ])
  expect(first.items[0]!.texture?.hash).toMatch(/^[a-f0-9]{64}$/)
  expect(await env.core.admin.listCloset(admin.uid, env.owner.uid, { page: 2, perPage: 2 })).toMatchObject({
    total: 3,
    items: [{ tid: publicTid, visibleToOwner: true, texture: { public: true } }],
  })
  expect(await env.core.admin.listCloset(admin.uid, env.owner.uid, { page: 3, perPage: 2 })).toEqual({
    total: 3,
    items: [],
  })
  deny('admin', 'textures.manage')
  const restricted = await env.core.admin.listCloset(admin.uid, env.owner.uid, { page: 1 })
  expect(restricted.items.map((item) => [item.tid, item.texture === null, item.visibleToOwner])).toEqual([
    [hidden, true, false],
    [own, true, true],
    [publicTid, false, true],
  ])
  // 衣柜名默认就是材质名，同材质一起隐藏
  expect(restricted.items[0]).toEqual({
    tid: hidden,
    name: null,
    scorePaid: 73,
    addedAt: old,
    visibleToOwner: false,
    texture: null,
  })
})

test('列表：默认每页五十件，越界仍返回总数', async () => {
  for (let i = 0; i < 51; i++) await legacyItem(env.owner.uid, await env.texture())
  const first = await env.core.admin.listCloset(admin.uid, env.owner.uid, { page: 1 })
  expect(first.total).toBe(51)
  expect(first.items).toHaveLength(50)
  expect((await env.core.admin.listCloset(admin.uid, env.owner.uid, { page: 2 })).items).toHaveLength(1)
  expect(await env.core.admin.listCloset(admin.uid, env.owner.uid, { page: 3 })).toEqual({ total: 51, items: [] })
})
