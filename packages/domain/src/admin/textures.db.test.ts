/**
 * ADR-0036 切片三的后台材质请求：逐入口授权、自有材质禁用、修改校验、下架清理与实付退款、重新公开、
 * 已注销上传者、固定预读/加锁交错、私有材质查询及审计失败回滚。经 core 调用，按 ADR 断言，四库共用。
 */
import { randomUUID } from 'node:crypto'
import { countRows, insertReturningId, type UserRole } from '@nextskin/db'
import type { KyselyPlugin, QueryId } from 'kysely'
import { beforeEach, expect, test, vi } from 'vitest'
import { can, type CorePermission } from '../access/permissions.ts'
import * as auditModule from '../audit/write.ts'
import { old, setup } from '../closet/test-support.ts'
import * as context from './context.ts'
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
  env.subscribe(
    'texture.updated',
    'closet.itemRemoved',
    'player.texturesChanged',
    'user.profileUpdated',
    'user.deleted',
  )
})

function deny(value: UserRole, permission: CorePermission) {
  vi.mocked(can).mockImplementation((r, p) => !(r === value && p === permission) && permissions.can(r, p))
}
async function role(uid: number, value: UserRole) {
  await env.db().updateTable('users').set({ role: value }).where('id', '=', uid).execute()
}
async function row(tid: number) {
  return env.db().selectFrom('textures').selectAll().where('id', '=', tid).executeTakeFirst()
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
    files: await env.db().selectFrom('texture_files').selectAll().orderBy('hash').execute(),
    closet: await env.db().selectFrom('closet_items').selectAll().orderBy('user_id').orderBy('texture_id').execute(),
    players: await env.db().selectFrom('players').selectAll().orderBy('id').execute(),
    reports: await env.db().selectFrom('reports').selectAll().orderBy('id').execute(),
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
function auditEntry(action: string, tid: number, details: Record<string, unknown>, actor = admin) {
  return {
    action,
    actor_type: 'user',
    actor_user_id: actor.uid,
    subject_type: 'texture',
    subject_id: tid,
    ip: actor.ip,
    created_at: env.now(),
    details,
  }
}
async function closet(uid: number, tid: number, paid: number) {
  await env
    .db()
    .insertInto('closet_items')
    .values({ user_id: uid, texture_id: tid, name: `衣柜${uid}`, score_paid: paid, created_at: old })
    .execute()
  await env
    .db()
    .updateTable('textures')
    .set((eb) => ({ likes: eb('likes', '+', 1) }))
    .where('id', '=', tid)
    .execute()
}
async function player(uid: number, tid: number, cape: number | null = null) {
  return insertReturningId(env.db(), 'players', {
    user_id: uid,
    name: `Player${uid}`,
    name_key: `player${uid}`,
    uuid: randomUUID().replaceAll('-', ''),
    skin_texture_id: tid,
    cape_texture_id: cape,
    score_paid: 17,
    created_at: old,
    updated_at: old,
  })
}
async function report(tid: number) {
  return insertReturningId(env.db(), 'reports', {
    texture_id: tid,
    uploader_id: env.owner.uid,
    reporter_id: env.actor.uid,
    status: 'pending',
    reason: '待核查',
    score_paid: 13,
    created_at: old,
  })
}
const operations = [
  {
    name: '修改',
    run: (actor: AdminActor, tid: number) => env.core.admin.updateTexture(actor, tid, { name: 'After' }),
  },
  { name: '下架', run: (actor: AdminActor, tid: number) => env.core.admin.unpublishTexture(actor, tid) },
]

test.each(operations)('$name：没有 textures.manage 时拒绝，材质、积分、审计和事件都不变', async ({ run }) => {
  const tid = await env.texture()
  const banned = await env.user('banned')
  await role(banned.uid, 'banned')
  for (const actor of [
    { ...env.actor, ip: null },
    { ...banned, ip: null },
  ])
    await unchanged(() => run(actor, tid), 'permission_denied')
  deny('admin', 'textures.manage')
  await unchanged(() => run(admin, tid), 'permission_denied')
})

test.each(operations)(
  '$name：管理员和超级管理员自己的材质返回 admin_own_texture，不存在返回 texture_not_found',
  async ({ run }) => {
    for (const actor of [admin, superadmin]) {
      for (const visible of [true, false]) {
        const tid = await env.texture('steve', visible)
        await env.db().updateTable('textures').set({ uploader_id: actor.uid }).where('id', '=', tid).execute()
        await unchanged(() => run(actor, tid), 'admin_own_texture')
      }
    }
    await unchanged(() => run(admin, 2147483647), 'texture_not_found')
  },
)

test.each(operations)('$name：其他管理员、超级管理员的材质都能管理，不按上传者等级限制', async ({ run }) => {
  const peer = await env.user('peer')
  await role(peer.uid, 'admin')
  for (const [actor, uploader] of [
    [admin, peer.uid],
    [admin, superadmin.uid],
    [superadmin, admin.uid],
  ] as const) {
    const tid = await env.texture()
    await env.db().updateTable('textures').set({ uploader_id: uploader }).where('id', '=', tid).execute()
    await run(actor, tid)
    expect((await logs()).at(-1)).toMatchObject({ actor_user_id: actor.uid, subject_id: tid })
    expect((await env.events('texture.updated')).at(-1)?.actor).toEqual({
      kind: 'user',
      uid: actor.uid,
      role: actor.uid === superadmin.uid ? 'superadmin' : 'admin',
    })
  }
})

test('修改：名字、Steve/Alex、可空描述；不要求验证邮箱，不动任何人的积分，描述审计只记长度', async () => {
  const tid = await env.texture()
  await env.db().updateTable('textures').set({ description: '旧😀', score_paid: 47 }).where('id', '=', tid).execute()
  await env.setting('auth.requireEmailVerification', true)
  await env.setting('score.perKbPublic', 9999)
  await env.setting('score.perKbPrivate', 8888)
  await env.db().updateTable('users').set({ email_verified: false }).where('id', '=', admin.uid).execute()
  const balances = await env.db().selectFrom('users').select(['id', 'score']).orderBy('id').execute()
  env.tick()
  const changed = await env.core.admin.updateTexture(admin, tid, {
    name: ' 新名字 ',
    type: 'alex',
    description: '新😀文',
  })
  expect(changed).toMatchObject({ tid, name: '新名字', type: 'alex', description: '新😀文', public: true })
  expect(await row(tid)).toMatchObject({ score_paid: 47, updated_at: env.now() })
  expect(await env.events('texture.updated')).toEqual([
    expect.objectContaining({
      actor: { kind: 'user', uid: admin.uid, role: 'admin' },
      data: { texture: changed, fields: ['name', 'type', 'description'] },
    }),
  ])
  const details = {
    name: '新名字',
    uploaderId: env.owner.uid,
    changes: {
      name: { from: 'Texture', to: '新名字' },
      type: { from: 'steve', to: 'alex' },
      description: { from: 2, to: 3 },
    },
  }
  expect(await logs()).toMatchObject([auditEntry('texture.update', tid, details)])
  expect((await logs())[0]!.details).toEqual(details)
  await env.core.admin.updateTexture(admin, tid, { type: 'steve', description: null })
  expect(await row(tid)).toMatchObject({ type: 'steve', description: null, score_paid: 47 })
  expect((await logs())[1]!.details).toEqual({
    name: '新名字',
    uploaderId: env.owner.uid,
    changes: { type: { from: 'alex', to: 'steve' }, description: { from: 3, to: 0 } },
  })
  expect(await env.db().selectFrom('users').select(['id', 'score']).orderBy('id').execute()).toEqual(balances)
  for (const { id } of balances) expect(await env.ledger(id)).toEqual([])
  const before = await snapshot()
  await env.core.admin.updateTexture(admin, tid, { name: '新名字', type: 'steve', description: null })
  expect(await snapshot()).toEqual(before)
})

test('修改：至少一项，名字和描述校验同上传者，失败时连带修改一起回滚', async () => {
  const tid = await env.texture()
  await unchanged(() => env.core.admin.updateTexture(admin, tid, {}), 'invalid_request')
  for (const name of ['', 'a'.repeat(129)])
    await unchanged(() => env.core.admin.updateTexture(admin, tid, { name }), 'texture_name_length')
  await env.setting('texture.nameRegex', '^Allowed$')
  await unchanged(() => env.core.admin.updateTexture(admin, tid, { name: 'Denied' }), 'texture_name_invalid')
  await unchanged(
    () => env.core.admin.updateTexture(admin, tid, { name: 'Allowed', description: 'a'.repeat(2001) }),
    'texture_description_too_long',
  )
})

test('修改：Alex 要求方形，皮肤和披风不能互转，失败不留下改名和审计', async () => {
  const skin = await env.texture(),
    cape = await env.texture('cape')
  const texture = (await row(skin))!
  await env.db().updateTable('texture_files').set({ height: 32 }).where('hash', '=', texture.hash).execute()
  for (const [tid, type] of [
    [skin, 'alex'],
    [skin, 'cape'],
    [cape, 'steve'],
    [cape, 'alex'],
  ] as const)
    await unchanged(() => env.core.admin.updateTexture(admin, tid, { name: 'After', type }), 'texture_type_invalid')
})

test.each([true, false])(
  '下架：退款开关 %s，移除所有非上传者引用（含管理员自己），保留上传者实付与引用、待处理举报',
  async (refund) => {
    await env.setting('score.refundOnDelete', refund)
    await env.setting('score.perClosetItem', 9999)
    const tid = await env.texture(),
      otherCape = await env.texture('cape')
    await env.db().updateTable('textures').set({ score_paid: 47 }).where('id', '=', tid).execute()
    for (const [uid, paid] of [
      [env.owner.uid, 31],
      [env.actor.uid, 73],
      [admin.uid, 19],
    ] as const)
      await closet(uid, tid, paid)
    const ownerPlayer = await player(env.owner.uid, tid),
      otherPlayer = await player(env.actor.uid, tid, tid),
      adminPlayer = await player(admin.uid, tid, otherCape)
    // 没有衣柜项也必须按角色/头像引用清理。
    const avatarOnly = await env.user('avatarOnly'),
      playerOnly = await env.user('playerOnly')
    const barePlayer = await player(playerOnly.uid, tid)
    for (const uid of [env.owner.uid, env.actor.uid, admin.uid, avatarOnly.uid])
      await env.db().updateTable('users').set({ avatar_texture_id: tid }).where('id', '=', uid).execute()
    const rid = await report(tid)
    const pending = await env.db().selectFrom('reports').selectAll().where('id', '=', rid).executeTakeFirstOrThrow()
    const ownerBefore = await row(tid),
      ownerPlayerBefore = await env
        .db()
        .selectFrom('players')
        .selectAll()
        .where('id', '=', ownerPlayer)
        .executeTakeFirstOrThrow()
    const balances = [await env.balance(env.owner.uid), await env.balance(env.actor.uid), await env.balance(admin.uid)]
    expect(await env.core.admin.textureDeletionImpact(admin.uid, tid)).toEqual({
      likes: 3,
      pendingReports: 1,
      othersInCloset: 2,
    })
    env.tick()
    const changed = await env.core.admin.unpublishTexture(admin, tid)
    expect(changed).toMatchObject({ tid, public: false, likes: 1 })
    expect(await row(tid)).toMatchObject({ score_paid: ownerBefore!.score_paid, is_public: 0, likes: 1 })
    expect([await env.balance(env.owner.uid), await env.balance(env.actor.uid), await env.balance(admin.uid)]).toEqual([
      balances[0],
      balances[1]! + (refund ? 73 : 0),
      balances[2]! + (refund ? 19 : 0),
    ])
    expect(await env.ledger(env.owner.uid)).toEqual([])
    for (const [uid, paid] of [
      [env.actor.uid, 73],
      [admin.uid, 19],
    ] as const)
      expect(await env.ledger(uid)).toEqual(
        refund
          ? [
              expect.objectContaining({
                delta: paid,
                reason: 'score.reasons.closetItemRefunded',
                subject_type: 'texture',
                subject_id: tid,
              }),
            ]
          : [],
      )
    expect(await env.db().selectFrom('closet_items').selectAll().where('texture_id', '=', tid).execute()).toMatchObject(
      [{ user_id: env.owner.uid, score_paid: 31 }],
    )
    expect(
      await env.db().selectFrom('players').selectAll().where('id', '=', ownerPlayer).executeTakeFirstOrThrow(),
    ).toEqual(ownerPlayerBefore)
    for (const [pid, cape] of [
      [otherPlayer, null],
      [adminPlayer, otherCape],
      [barePlayer, null],
    ] as const)
      expect(
        await env.db().selectFrom('players').selectAll().where('id', '=', pid).executeTakeFirstOrThrow(),
      ).toMatchObject({ skin_texture_id: null, cape_texture_id: cape, updated_at: env.now() })
    for (const uid of [env.owner.uid, env.actor.uid, admin.uid, avatarOnly.uid])
      expect(
        await env.db().selectFrom('users').select('avatar_texture_id').where('id', '=', uid).executeTakeFirstOrThrow(),
      ).toEqual({ avatar_texture_id: uid === env.owner.uid ? tid : null })
    expect(await env.db().selectFrom('reports').selectAll().where('id', '=', rid).executeTakeFirstOrThrow()).toEqual(
      pending,
    )
    const details = { name: 'Texture', uploaderId: env.owner.uid, closetItemsRemoved: 2, refunded: refund ? 92 : 0 }
    expect(await logs()).toMatchObject([auditEntry('texture.unpublish', tid, details)])
    expect((await logs())[0]!.details).toEqual(details)
    expect(await env.events('texture.updated')).toEqual([
      expect.objectContaining({ data: { texture: changed, fields: ['public'] } }),
    ])
    expect((await env.events('closet.itemRemoved')).map((event) => event.data)).toEqual([
      { uid: env.actor.uid, tid },
      { uid: admin.uid, tid },
    ])
    expect((await env.events('player.texturesChanged')).map((event) => event.data)).toMatchObject([
      {
        player: { pid: otherPlayer, skin: null, cape: null },
        previous: { skin: tid, cape: tid },
      },
      {
        player: { pid: adminPlayer, skin: null, cape: otherCape },
        previous: { skin: tid, cape: otherCape },
      },
      {
        player: { pid: barePlayer, skin: null, cape: null },
        previous: { skin: tid, cape: null },
      },
    ])
    expect((await env.events('user.profileUpdated')).map((event) => event.data)).toEqual(
      [env.actor.uid, admin.uid, avatarOnly.uid].map((uid) => ({ uid, fields: ['avatar'] })),
    )
    for (const name of [
      'texture.updated',
      'closet.itemRemoved',
      'player.texturesChanged',
      'user.profileUpdated',
    ] as const)
      for (const event of await env.events(name))
        expect(event.actor).toEqual({ kind: 'user', uid: admin.uid, role: 'admin' })
    await env.consistent(tid)
    const before = await snapshot()
    await env.core.admin.unpublishTexture(admin, tid)
    expect(await snapshot()).toEqual(before)
  },
)

test.each([47, 21, 80])('下架后上传者重新公开：非导入材质按实付 47 减现价 %s 多退少补', async (price) => {
  await env.setting('score.perKbPublic', 47)
  await env.setting('score.perKbPrivate', 3)
  // 用用户自己的切换产生实付，避免把导入状态冒充按当前计费产生的材质。
  const tid = await env.texture('steve', false)
  expect((await env.core.textures.update(env.owner, tid, { public: true })).scoreDelta).toBe(-47)
  expect(await row(tid)).toMatchObject({ score_paid: 47 })
  const balance = await env.balance(env.owner.uid)
  await env.core.admin.unpublishTexture(admin, tid)
  expect(await env.balance(env.owner.uid)).toBe(balance)
  expect(await row(tid)).toMatchObject({ score_paid: 47 })
  await env.setting('score.perKbPublic', price)
  const result = await env.core.textures.update(env.owner, tid, { public: true })
  expect(result).toMatchObject({ scoreDelta: 47 - price, texture: { public: true } })
  expect(await env.balance(env.owner.uid)).toBe(balance + 47 - price)
  expect(await row(tid)).toMatchObject({ score_paid: price })
  await env.consistent(tid)
})

test('上传者已注销：公开材质能改名，但下架返回 texture_uploader_gone 并保持全部状态', async () => {
  const tid = await env.texture()
  await env.core.admin.deleteUser(admin, env.owner.uid, { publicTextures: 'keep' })
  expect(await row(tid)).toMatchObject({ uploader_id: null, is_public: 1 })
  const changed = await env.core.admin.updateTexture(admin, tid, { name: '已注销的作品' })
  expect(changed).toMatchObject({ name: '已注销的作品' })
  expect((await logs()).at(-1)).toMatchObject(
    auditEntry('texture.update', tid, {
      name: '已注销的作品',
      uploaderId: null,
      changes: { name: { from: 'Texture', to: '已注销的作品' } },
    }),
  )
  await unchanged(() => env.core.admin.unpublishTexture(admin, tid), 'texture_uploader_gone')
})

test('上传者为空的私有导入遗留材质：下架是 no-op，没有审计和事件', async () => {
  const tid = await env.texture('steve', false)
  await env.db().updateTable('textures').set({ uploader_id: null }).where('id', '=', tid).execute()
  const before = await snapshot()
  expect(await env.core.admin.unpublishTexture(admin, tid)).toMatchObject({ tid, public: false })
  expect(await snapshot()).toEqual(before)
})

test('并发注销：下架预读上传者之后、锁上传者之前注销提交，不能产生无上传者的私有材质', async () => {
  const tid = await env.texture()
  const checkpoint = new Error('在上传者锁前让注销先提交')
  let reached = false,
    replayed = 0
  const lock = vi.spyOn(context, 'lockTarget').mockImplementationOnce((_tx, uid) => {
    expect(uid).toBe(env.owner.uid)
    reached = true
    return Promise.reject(checkpoint)
  })
  // SQLite 已在 authorize 锁住管理员，不能在持有唯一写连接时嵌套注销。
  // 在准确的预读/锁边界回滚无业务写入的前奏，提交真实注销，再重放前奏并保留原来的 uploader_id 预读。
  // 只替换这一条锁外读；lockTarget、锁内重读、下架及注销本身都使用真实数据库和事务。
  const staleReads = new Set<QueryId>()
  const staleUploader: KyselyPlugin = {
    transformQuery({ node, queryId }) {
      if (
        node.kind === 'SelectQueryNode' &&
        node.selections?.length === 1 &&
        JSON.stringify(node.selections).includes('uploader_id')
      )
        staleReads.add(queryId)
      return node
    },
    transformResult({ result, queryId }) {
      if (!staleReads.delete(queryId)) return Promise.resolve(result)
      replayed++
      return Promise.resolve({ ...result, rows: [{ uploader_id: env.owner.uid }] })
    },
  }
  const transaction = env.db().transaction.bind(env.db())
  const spy = vi.spyOn(env.db(), 'transaction').mockImplementationOnce(() => {
    const builder = transaction(),
      execute = builder.execute.bind(builder)
    builder.execute = async (callback) => {
      try {
        return await execute(callback)
      } catch (error) {
        if (error !== checkpoint) throw error
      }
      await env.core.admin.deleteUser(admin, env.owner.uid, { publicTextures: 'keep' })
      expect(await row(tid)).toMatchObject({ uploader_id: null, is_public: 1 })
      return execute((tx) => callback(tx.withPlugin(staleUploader)))
    }
    return builder
  })
  try {
    const result = await env.core.admin.unpublishTexture(admin, tid).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    expect(reached).toBe(true)
    expect(replayed).toBe(1)
    expect(await countRows(env.db().selectFrom('users').where('id', '=', env.owner.uid))).toBe(0)
    const final = await row(tid)
    expect(final === undefined || final.is_public === 1 || final.uploader_id !== null).toBe(true)
    if (final) expect(result).toMatchObject({ error: { code: 'texture_uploader_gone' } })
    expect((await logs()).filter((entry) => entry.action === 'texture.unpublish')).toEqual([])
    expect(await env.events('texture.updated')).toEqual([])
  } finally {
    spy.mockRestore()
    lock.mockRestore()
  }
})

test('查看：管理员 detail 看见别人的私有材质，othersPrivate 标明；普通用户与缺权限的管理员照旧看不到', async () => {
  const tid = await env.texture('steve', false)
  expect(await env.core.textures.detail(admin.uid, tid)).toMatchObject({
    tid,
    name: 'Texture',
    public: false,
    othersPrivate: true,
    uploader: { uid: env.owner.uid },
  })
  expect(await env.core.textures.detail(env.owner.uid, tid)).toMatchObject({ tid, othersPrivate: false })
  for (const viewer of [null, env.actor.uid]) expect(await env.core.textures.detail(viewer, tid)).toBeNull()
  deny('admin', 'textures.manage')
  expect(await env.core.textures.detail(admin.uid, tid)).toBeNull()
})

test('查看：按上传者包含私有，gone 仅管理员生效，总列表始终只有公开，权限从数据库读取', async () => {
  const ownPublic = await env.texture(),
    ownPrivate = await env.texture('alex', false),
    gonePublic = await env.texture(),
    gonePrivate = await env.texture('steve', false)
  await env
    .db()
    .updateTable('textures')
    .set({ uploader_id: null })
    .where('id', 'in', [gonePublic, gonePrivate])
    .execute()
  const list = (viewer: number | null, uploader?: number | 'gone') =>
    env.core.textures.list({ viewer, uploader, type: 'skin', sort: 'latest', page: 1 })
  expect((await list(admin.uid, env.owner.uid)).items.map((item) => item.tid)).toEqual([ownPrivate, ownPublic])
  for (const viewer of [env.actor.uid, null])
    expect((await list(viewer, env.owner.uid)).items.map((item) => item.tid)).toEqual([ownPublic])
  expect((await list(admin.uid, 'gone')).items.map((item) => item.tid)).toEqual([gonePrivate, gonePublic])
  expect(await env.core.textures.detail(admin.uid, gonePrivate)).toMatchObject({ othersPrivate: true, uploader: null })
  for (const viewer of [admin.uid, env.actor.uid, null])
    expect((await list(viewer)).items.map((item) => item.tid)).toEqual([gonePublic, ownPublic])
  for (const viewer of [env.actor.uid, null]) expect(await list(viewer, 'gone')).toEqual(await list(viewer))
  deny('admin', 'textures.manage')
  expect((await list(admin.uid, env.owner.uid)).items.map((item) => item.tid)).toEqual([ownPublic])
  expect(await list(admin.uid, 'gone')).toEqual(await list(admin.uid))
  expect(await env.core.admin.textureDeletionImpact(admin.uid, ownPublic)).toBeNull()
  vi.mocked(can).mockImplementation(permissions.can)
  await role(admin.uid, 'user')
  expect(await env.core.textures.detail(admin.uid, ownPrivate)).toBeNull()
  expect(await list(admin.uid, 'gone')).toEqual(await list(admin.uid))
})

test.each(operations)('$name：审计写入抛错，材质、衣柜移除、退分、角色、头像、举报和事件整体回滚', async ({ run }) => {
  await env.setting('score.refundOnDelete', true)
  const tid = await env.texture()
  await closet(env.actor.uid, tid, 73)
  await player(env.actor.uid, tid)
  await env.db().updateTable('users').set({ avatar_texture_id: tid }).where('id', '=', env.actor.uid).execute()
  await report(tid)
  const before = await snapshot()
  const spy = vi.spyOn(auditModule, 'audit').mockImplementationOnce(async (tx, input) => {
    // 在审计边界验证业务已经发生，防止仅证明“什么都没执行就失败”。
    if (input.action === 'texture.unpublish') {
      expect(await countRows(tx.selectFrom('closet_items').where('texture_id', '=', tid))).toBe(0)
      expect(
        await tx.selectFrom('users').select('score').where('id', '=', env.actor.uid).executeTakeFirstOrThrow(),
      ).toEqual({ score: 1073 })
      expect(
        await tx.selectFrom('textures').select('is_public').where('id', '=', tid).executeTakeFirstOrThrow(),
      ).toEqual({ is_public: 0 })
    }
    throw new Error('模拟审计失败')
  })
  try {
    await expect(run(admin, tid)).rejects.toThrow('模拟审计失败')
    expect(spy).toHaveBeenCalledTimes(1)
  } finally {
    spy.mockRestore()
  }
  expect(await snapshot()).toEqual(before)
})
