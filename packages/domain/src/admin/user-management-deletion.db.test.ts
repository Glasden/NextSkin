/**
 * 后台删除用户（ADR-0036"删除用户"）：删掉的数据同删除账号，公开材质默认留下、可以逐个删除且中途失败能接着删，
 * 连带删掉的材质照管理员删除材质处理但不发奖励，审计快照有上限。权限矩阵在 user-management.db.test.ts
 */
import { randomUUID } from 'node:crypto'
import { countRows, type UserRole } from '@nextskin/db'
import { beforeEach, expect, test, vi } from 'vitest'
import { can, type CorePermission } from '../access/permissions.ts'
import { old, setup } from '../closet/test-support.ts'
import { MAIL_JOB } from '../mail/service.ts'
import type { AdminActor } from './types.ts'

// 授权表落地之前，两种管理员的后台权限都是全的；从 admin 身上拿掉 textures.manage，才能验证"连公开材质一起删"另查这一项
vi.mock('../access/permissions.ts', { spy: true })
const permissions = await vi.importActual<typeof import('../access/permissions.ts')>('../access/permissions.ts')

const env = setup()
let admin: AdminActor
const adminActor = () => ({ kind: 'user', uid: admin.uid, role: 'admin' })

beforeEach(async () => {
  vi.mocked(can).mockImplementation(permissions.can)
  await env.db().deleteFrom('audit_logs').execute()
  admin = { ...(await env.user('admin')), ip: '2001:db8::1' }
  await role(admin.uid, 'admin')
  await env.setting('report.cost', 11)
  // 管理员删除材质本来发奖励；删除用户连带删掉的不发（ADR-0036）
  await env.setting('report.reward', 7)
  await env.setting('score.refundOnDelete', true)
  await env.setting('score.perClosetItem', 5)
  // 删除用户不发通知：配置了邮件也不应入队
  await env.setting('mail.transport', 'smtp')
  await env.setting('mail.from', { address: 'sender@example.test', name: 'NextSkin' })
  env.subscribe(
    'player.deleted',
    'closet.itemRemoved',
    'texture.deleted',
    'user.deleted',
    'report.resolved',
    'player.texturesChanged',
  )
})

function deny(roleValue: UserRole, permission: CorePermission) {
  vi.mocked(can).mockImplementation((r, p) => !(r === roleValue && p === permission) && permissions.can(r, p))
}
async function role(uid: number, value: UserRole) {
  await env.db().updateTable('users').set({ role: value }).where('id', '=', uid).execute()
}
async function logs() {
  return (await env.db().selectFrom('audit_logs').selectAll().orderBy('id').execute()).map((row) => ({
    ...row,
    details: JSON.parse(row.details) as Record<string, unknown>,
  }))
}
async function texture(tid: number) {
  return env.db().selectFrom('textures').selectAll().where('id', '=', tid).executeTakeFirst()
}
async function exists(uid: number) {
  return (await countRows(env.db().selectFrom('users').where('id', '=', uid))) === 1
}
/** 每个用户的流水之和等于余额（材质都删掉了，用不了 env.consistent） */
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
async function report(id: number) {
  return env.db().selectFrom('reports').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
}
/** 上传者是 uploader 的公开材质 */
async function uploadedBy(uploader: number) {
  const tid = await env.texture()
  await env.db().updateTable('textures').set({ uploader_id: uploader }).where('id', '=', tid).execute()
  return tid
}
/** 让某个材质的 texture.deleted 事件入队失败，模拟删到它时出错 */
function failDeleting(tid: number) {
  const enqueue = env.core.jobs.enqueue.bind(env.core.jobs)
  return vi.spyOn(env.core.jobs, 'enqueue').mockImplementation((executor, name, payload, options) => {
    if (name === 'test:texture.deleted' && (payload as { data: { tid: number } }).data.tid === tid)
      return Promise.reject(new Error('模拟删除失败'))
    return enqueue(executor, name, payload, options)
  })
}

test('删掉的数据同删除账号；公开材质默认留下；私有材质照管理员删除处理、举报结案不发奖励；连带事件的 actor 是管理员；不发通知', async () => {
  const owner = env.owner.uid,
    actor = env.actor.uid
  const pubA = await env.texture(),
    pubB = await env.texture(),
    priv = await env.texture()
  const foreign = await uploadedBy(actor)
  // 举报要在材质公开时提交，之后上传者改成私有
  const privReport = await env.core.reports.create(env.actor, { tid: priv, reason: '私有' })
  const pubReport = await env.core.reports.create(env.actor, { tid: pubA, reason: '公开' })
  await env.core.textures.update(env.owner, priv, { public: false })
  await env.core.closet.add(env.owner, { tid: foreign })
  await env.core.closet.add(env.owner, { tid: priv })
  await env.core.closet.add(env.actor, { tid: pubA })
  const players = [
    await env.core.players.create(env.owner, { name: 'Steve' }),
    await env.core.players.create(env.owner, { name: 'Alex' }),
  ]
  const kept = await env.core.players.create(env.actor, { name: 'Other' })
  for (const uid of [owner, actor])
    await env
      .db()
      .insertInto('oauth_clients')
      .values({ user_id: uid, client_id: `client-${uid}`, redirect_uris: '[]' })
      .execute()
  const privRow = (await texture(priv))!
  const ownerScore = await env.balance(owner),
    actorScore = await env.balance(actor)
  await env.db().deleteFrom('jobs').execute()

  await env.core.admin.deleteUser(admin, owner, { publicTextures: 'keep' })

  expect(await exists(owner)).toBe(false)
  expect(await countRows(env.db().selectFrom('players').where('user_id', '=', owner))).toBe(0)
  expect(await countRows(env.db().selectFrom('closet_items').where('user_id', '=', owner))).toBe(0)
  expect(await countRows(env.db().selectFrom('oauth_clients').where('user_id', '=', owner))).toBe(0)
  expect(await countRows(env.db().selectFrom('oauth_clients').where('user_id', '=', actor))).toBe(1)
  expect(await texture(priv)).toBeUndefined()
  expect(await texture(foreign)).toMatchObject({ uploader_id: actor, likes: 0 })
  expect(await texture(pubA)).toMatchObject({ uploader_id: null, likes: 1 })
  expect(await texture(pubB)).toMatchObject({ uploader_id: null })
  expect(await env.db().selectFrom('players').select('id').where('id', '=', kept.pid).executeTakeFirst()).toBeTruthy()
  // 结案的举报：处理人是这个管理员，举报费退还，奖励为 0
  expect(await report(privReport.id)).toMatchObject({
    status: 'resolved',
    resolution: 'textureDeleted',
    resolver_id: admin.uid,
    texture_id: null,
  })
  expect(await report(pubReport.id)).toMatchObject({ status: 'pending', texture_id: pubA, uploader_id: null })
  expect(await env.balance(actor)).toBe(actorScore + 11)
  expect((await env.ledger(actor)).map((row) => row.reason)).not.toContain('score.reasons.reportRewarded')
  const { items } = await env.core.admin.listReports(admin.uid, { status: 'resolved', page: 1 })
  expect(items.find((item) => item.id === privReport.id)).toMatchObject({
    resolver: { uid: admin.uid, nickname: 'admin' },
  })

  const audit = await logs()
  expect(
    audit.every((row) => row.actor_type === 'user' && row.actor_user_id === admin.uid && row.ip === admin.ip),
  ).toBe(true)
  expect(audit.map((row) => row.action).sort()).toEqual([
    'player.delete',
    'player.delete',
    'report.resolve',
    'texture.delete',
    'user.delete',
  ])
  expect(audit.find((row) => row.action === 'user.delete')).toMatchObject({
    subject_type: 'user',
    subject_id: owner,
    details: {
      nickname: 'owner',
      email: 'owner@example.test',
      role: 'user',
      score: ownerScore,
      players: 2,
      closetItems: 2,
      keptPublicTextures: { count: 2, tids: [pubA, pubB] },
    },
  })
  expect(audit.find((row) => row.action === 'user.delete')?.details).toEqual({
    nickname: 'owner',
    email: 'owner@example.test',
    role: 'user',
    score: ownerScore,
    players: 2,
    closetItems: 2,
    keptPublicTextures: { count: 2, tids: [pubA, pubB] },
  })
  // 角色删除以后，UUID 只留在 player.delete 里
  expect(
    audit
      .filter((row) => row.action === 'player.delete')
      .map((row) => ({ subject: [row.subject_type, row.subject_id], details: row.details }))
      .sort((a, b) => (a.details.pid as number) - (b.details.pid as number)),
  ).toEqual(
    players.map((player) => ({
      subject: ['user', owner],
      details: { pid: player.pid, name: player.name, uuid: player.uuid, scorePaid: 0 },
    })),
  )
  expect(audit.find((row) => row.action === 'texture.delete')).toMatchObject({
    subject_type: 'texture',
    subject_id: priv,
    details: { name: privRow.name, type: privRow.type, hash: privRow.hash, public: false, uploaderId: owner },
  })
  expect(audit.find((row) => row.action === 'report.resolve')).toMatchObject({
    subject_type: 'report',
    subject_id: privReport.id,
    details: { action: 'deleteTexture', tid: priv, refunded: 11, rewarded: 0 },
  })

  expect((await env.events('player.deleted')).map((event) => event.data)).toEqual(
    players.map((player) => ({ pid: player.pid, uid: owner, name: player.name, uuid: player.uuid })),
  )
  expect((await env.events('closet.itemRemoved')).map((event) => event.data)).toEqual(
    expect.arrayContaining([
      { uid: owner, tid: foreign },
      { uid: owner, tid: priv },
    ]),
  )
  expect(await env.events('closet.itemRemoved')).toHaveLength(2)
  expect(await env.events('texture.deleted')).toMatchObject([{ data: { tid: priv } }])
  expect(await env.events('report.resolved')).toHaveLength(1)
  expect(await env.events('user.deleted')).toMatchObject([{ data: { uid: owner } }])
  for (const name of [
    'player.deleted',
    'closet.itemRemoved',
    'texture.deleted',
    'user.deleted',
    'report.resolved',
  ] as const)
    for (const event of await env.events(name)) expect(event.actor).toEqual(adminActor())
  expect(await countRows(env.db().selectFrom('jobs').where('name', '=', MAIL_JOB))).toBe(0)
  await env.consistent(pubA)
  await env.consistent(foreign)
})

test('连公开材质一起删：一个材质一个事务，中途失败不回滚已经删掉的，重新提交接着删完；举报结案、处理人是管理员、不发奖励', async () => {
  const owner = env.owner.uid,
    actor = env.actor.uid
  const tids = [await env.texture(), await env.texture(), await env.texture()]
  const [first, second] = tids as [number, number, number]
  // 上传时付过存储费：管理员删除不退给上传者（ADR-0027），连带删掉的照此处理
  await env.db().updateTable('textures').set({ score_paid: 20 }).where('id', 'in', tids).execute()
  const rows = await Promise.all(tids.map(async (tid) => (await texture(tid))!))
  for (const tid of tids) await env.core.closet.add(env.actor, { tid })
  const player = await env.core.players.create(env.actor, { name: 'Actor' })
  await env.core.players.update(env.actor, player.pid, { skin: first })
  const pending = await env.core.reports.create(env.actor, { tid: second, reason: '刷屏' })
  await env.core.players.create(env.owner, { name: 'Owner' })
  const actorScore = await env.balance(actor)
  const ownerScore = await env.balance(owner)
  await env.db().deleteFrom('jobs').execute()

  const spy = failDeleting(second)
  try {
    await expect(env.core.admin.deleteUser(admin, owner, { publicTextures: 'delete' })).rejects.toThrow('模拟删除失败')
  } finally {
    spy.mockRestore()
  }
  // 第一个已经删掉并提交，账号还在
  expect(await texture(first)).toBeUndefined()
  expect(await texture(second)).toMatchObject({ uploader_id: owner, is_public: 1 })
  expect(await exists(owner)).toBe(true)
  expect(await env.balance(owner)).toBe(ownerScore)
  expect((await env.ledger(owner)).map((row) => row.reason)).not.toContain('score.reasons.textureDeleted')
  expect(await report(pending.id)).toMatchObject({ status: 'pending' })
  expect(
    await env.db().selectFrom('players').select('skin_texture_id').where('id', '=', player.pid).executeTakeFirst(),
  ).toEqual({ skin_texture_id: null })
  expect((await logs()).map((row) => [row.action, row.subject_id])).toEqual([['texture.delete', first]])

  await env.core.admin.deleteUser(admin, owner, { publicTextures: 'delete' })

  for (const tid of tids) expect(await texture(tid)).toBeUndefined()
  expect(await exists(owner)).toBe(false)
  expect(await report(pending.id)).toMatchObject({ status: 'resolved', resolver_id: admin.uid })
  const { items } = await env.core.admin.listReports(admin.uid, { status: 'resolved', page: 1 })
  expect(items.find((item) => item.id === pending.id)).toMatchObject({
    resolver: { uid: admin.uid, nickname: 'admin' },
  })
  // 别人衣柜里的按实付退还，举报费退还，没有奖励
  expect(await env.balance(actor)).toBe(actorScore + 3 * 5 + 11)
  expect(
    (await env.ledger(actor))
      .filter((row) => row.reason === 'score.reasons.closetItemRefunded')
      .map((row) => row.delta),
  ).toEqual([5, 5, 5])
  expect((await env.ledger(actor)).map((row) => row.reason)).not.toContain('score.reasons.reportRewarded')
  const audit = await logs()
  expect(audit.every((row) => row.actor_user_id === admin.uid && row.ip === admin.ip)).toBe(true)
  expect(
    audit
      .filter((row) => row.action === 'texture.delete')
      .sort((a, b) => a.subject_id - b.subject_id)
      .map((row) => ({ subject: [row.subject_type, row.subject_id], details: row.details })),
  ).toEqual(
    rows.map((row) => ({
      subject: ['texture', row.id],
      details: { name: row.name, type: row.type, hash: row.hash, public: true, uploaderId: owner },
    })),
  )
  expect(audit.filter((row) => row.action === 'report.resolve')).toMatchObject([
    {
      subject_id: pending.id,
      details: { action: 'deleteTexture', tid: second, refunded: 11, rewarded: 0 },
    },
  ])
  expect(audit.filter((row) => row.action === 'user.delete')).toMatchObject([
    { details: { score: ownerScore, players: 1, closetItems: 0, keptPublicTextures: { count: 0, tids: [] } } },
  ])
  expect(audit.filter((row) => row.action === 'player.delete')).toHaveLength(1)
  expect(
    (await env.events('texture.deleted')).map((event) => (event.data as { tid: number }).tid).sort((a, b) => a - b),
  ).toEqual(tids)
  expect(await env.events('player.texturesChanged')).toMatchObject([
    { actor: adminActor(), data: { player: { pid: player.pid, skin: null }, previous: { skin: first } } },
  ])
  for (const name of ['texture.deleted', 'closet.itemRemoved', 'report.resolved', 'user.deleted'] as const)
    for (const event of await env.events(name)) expect(event.actor).toEqual(adminActor())
  await balanced()
})

test('逐个删公开材质的中途对象被提拔成管理员：下一个材质的事务里发现动不了他就停下，已经删掉的不恢复，剩下的和账号都不动', async () => {
  const owner = env.owner.uid
  const [first, second, third] = [await env.texture(), await env.texture(), await env.texture()]
  // 第一个材质的事务里把对象提拔成管理员：预检早就过了，只有每个材质事务里锁住之后的检查拦得住
  const enqueue = env.core.jobs.enqueue.bind(env.core.jobs)
  const spy = vi.spyOn(env.core.jobs, 'enqueue').mockImplementation(async (executor, name, payload, options) => {
    if (name === 'test:texture.deleted' && (payload as { data: { tid: number } }).data.tid === first)
      await executor.updateTable('users').set({ role: 'admin' }).where('id', '=', owner).execute()
    return enqueue(executor, name, payload, options)
  })
  try {
    await expect(env.core.admin.deleteUser(admin, owner, { publicTextures: 'delete' })).rejects.toMatchObject({
      code: 'user_not_manageable',
    })
  } finally {
    spy.mockRestore()
  }
  expect(await texture(first)).toBeUndefined()
  expect(await texture(second)).toMatchObject({ uploader_id: owner, is_public: 1 })
  expect(await texture(third)).toMatchObject({ uploader_id: owner, is_public: 1 })
  expect(await exists(owner)).toBe(true)
  expect((await logs()).map((row) => [row.action, row.subject_id])).toEqual([['texture.delete', first]])
})

test('连公开材质一起删时，只有删账号的那个事务整体回滚：已经删掉的公开材质不恢复，账号、角色、私有材质和它们的审计都不留', async () => {
  const owner = env.owner.uid
  const pub = await env.texture(),
    priv = await env.texture('steve', false)
  await env.core.players.create(env.owner, { name: 'Owner' })
  const enqueue = env.core.jobs.enqueue.bind(env.core.jobs)
  const spy = vi
    .spyOn(env.core.jobs, 'enqueue')
    .mockImplementation((executor, name, payload, options) =>
      name === 'test:user.deleted'
        ? Promise.reject(new Error('模拟提交失败'))
        : enqueue(executor, name, payload, options),
    )
  try {
    await expect(env.core.admin.deleteUser(admin, owner, { publicTextures: 'delete' })).rejects.toThrow('模拟提交失败')
  } finally {
    spy.mockRestore()
  }
  expect(await texture(pub)).toBeUndefined()
  expect(await texture(priv)).toMatchObject({ uploader_id: owner })
  expect(await exists(owner)).toBe(true)
  expect(await countRows(env.db().selectFrom('players').where('user_id', '=', owner))).toBe(1)
  expect((await logs()).map((row) => [row.action, row.subject_id])).toEqual([['texture.delete', pub]])
  expect(await env.events('player.deleted')).toEqual([])
  await env.core.admin.deleteUser(admin, owner, { publicTextures: 'delete' })
  expect(await exists(owner)).toBe(false)
  expect(await texture(priv)).toBeUndefined()
  expect((await logs()).map((row) => row.action).sort()).toEqual([
    'player.delete',
    'texture.delete',
    'texture.delete',
    'user.delete',
  ])
})

test('连公开材质一起删还要 textures.manage；被封禁的对象也能删', async () => {
  const owner = env.owner.uid
  const pub = await env.texture()
  await role(owner, 'banned')
  deny('admin', 'textures.manage')
  await expect(env.core.admin.deleteUser(admin, owner, { publicTextures: 'delete' })).rejects.toMatchObject({
    code: 'permission_denied',
  })
  expect(await exists(owner)).toBe(true)
  expect(await texture(pub)).toMatchObject({ uploader_id: owner })
  expect(await logs()).toEqual([])
  // 公开材质留下时只要 users.manage
  await env.core.admin.deleteUser(admin, owner, { publicTextures: 'keep' })
  expect(await exists(owner)).toBe(false)
  expect(await texture(pub)).toMatchObject({ uploader_id: null })
  expect(await logs()).toMatchObject([
    {
      action: 'user.delete',
      details: { role: 'banned', keptPublicTextures: { count: 1, tids: [pub] } },
    },
  ])
})

test('上千个角色、留下上万个公开材质的用户也能删：每个角色一条带 UUID 的审计，快照里的 tid 只有 100 个', async () => {
  const owner = env.owner.uid
  const players = 1000,
    textures = 10_000
  const hash = 'f'.repeat(64)
  await env
    .db()
    .insertInto('texture_files')
    .values({
      hash,
      pixel_hash: hash,
      width: 64,
      height: 64,
      size_bytes: 100,
      ref_count: textures,
      status: 'active',
      status_changed_at: old,
      created_at: old,
    })
    .execute()
  for (let start = 0; start < textures; start += 500)
    await env
      .db()
      .insertInto('textures')
      .values(
        Array.from({ length: 500 }, (_, i) => ({
          hash,
          type: 'steve' as const,
          name: `Bulk ${start + i}`,
          uploader_id: owner,
          is_public: 1 as const,
          created_at: old,
          updated_at: old,
        })),
      )
      .execute()
  const uuids: string[] = []
  for (let start = 0; start < players; start += 500)
    await env
      .db()
      .insertInto('players')
      .values(
        Array.from({ length: 500 }, (_, i) => {
          const uuid = randomUUID().replaceAll('-', '')
          uuids.push(uuid)
          return {
            user_id: owner,
            name: `bulk${start + i}`,
            name_key: `bulk${start + i}`,
            uuid,
            skin_texture_id: null,
            cape_texture_id: null,
            created_at: old,
            updated_at: old,
          }
        }),
      )
      .execute()
  const firstTids = (
    await env
      .db()
      .selectFrom('textures')
      .select('id')
      .where('uploader_id', '=', owner)
      .orderBy('id')
      .limit(100)
      .execute()
  ).map((row) => row.id)

  await env.core.admin.deleteUser(admin, owner, { publicTextures: 'keep' })

  expect(await exists(owner)).toBe(false)
  expect(await countRows(env.db().selectFrom('textures').where('uploader_id', 'is', null))).toBe(textures)
  const rows = await env.db().selectFrom('audit_logs').select(['action', 'details']).orderBy('id').execute()
  const snapshot = rows.find((row) => row.action === 'user.delete')!
  // MySQL 上 details 是 text，最长 64 KB：快照里不放没有上限的列表
  expect(snapshot.details.length).toBeLessThan(4096)
  expect(JSON.parse(snapshot.details)).toMatchObject({
    players,
    keptPublicTextures: { count: textures, tids: firstTids },
  })
  const deleted = rows
    .filter((row) => row.action === 'player.delete')
    .map((row) => (JSON.parse(row.details) as { uuid: string }).uuid)
  expect(deleted.sort()).toEqual(uuids.sort())
}, 120_000)
