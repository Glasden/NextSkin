import { countRows, toIsoTimestamp, transactionWithRetry, writeAuthDate, type UserRole } from '@nextskin/db'
import { hashPassword } from 'better-auth/crypto'
import { beforeEach, expect, test, vi } from 'vitest'
import { setup, old } from '../closet/test-support.ts'
import { adjustScore } from '../score/adjust.ts'
import type { AssignableRole } from './types.ts'

const env = setup()
let admin: { uid: number; ip: string | null }, superadmin: { uid: number; ip: string | null }
beforeEach(async () => {
  await env.db().deleteFrom('audit_logs').execute()
  admin = { ...(await env.user('admin')), ip: '2001:db8::123' }
  superadmin = { ...(await env.user('superadmin')), ip: '192.0.2.1' }
  await role(admin.uid, 'admin')
  await role(superadmin.uid, 'superadmin')
  await env.setting('report.cost', 11)
  await env.setting('report.reward', 7)
  await env.setting('score.refundOnDelete', true)
  env.subscribe('report.resolved', 'user.roleChanged')
})
async function role(uid: number, value: UserRole) {
  await env.db().updateTable('users').set({ role: value }).where('id', '=', uid).execute()
}
async function logs() {
  return env.db().selectFrom('audit_logs').selectAll().orderBy('id').execute()
}
async function consistent() {
  for (const user of await env.db().selectFrom('users').select(['id', 'score']).execute()) {
    const entries = await env
      .db()
      .selectFrom('score_transactions')
      .select('delta')
      .where('user_id', '=', user.id)
      .execute()
    expect(entries.reduce((sum, row) => sum + row.delta, 0)).toBe(user.score)
  }
}
async function paidTexture() {
  const tid = await env.texture()
  await env.db().updateTable('textures').set({ score_paid: 25 }).where('id', '=', tid).execute()
  await transactionWithRetry(env.db(), (tx) =>
    adjustScore(tx, { uid: env.owner.uid, delta: -25, reason: 'score.reasons.textureUploaded', now: env.now() }),
  )
  return tid
}
async function credential(uid: number) {
  const password = 'password123'
  await env
    .db()
    .insertInto('accounts')
    .values({
      user_id: uid,
      provider_id: 'credential',
      account_id: String(uid),
      password: await hashPassword(password),
      created_at: writeAuthDate(env.db(), old),
      updated_at: writeAuthDate(env.db(), old),
    })
    .execute()
  return { password }
}

test('两个管理员竞争同一举报只采纳一次、退奖一次、事件和审计一次', async () => {
  const tid = await env.texture()
  const report = await env.core.reports.create(env.actor, { tid, reason: '违规' })
  const results = await Promise.allSettled([
    env.core.admin.resolveReport(admin, report.id, 'banUploader'),
    env.core.admin.resolveReport(superadmin, report.id, 'banUploader'),
  ])
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter((r) => r.status === 'rejected')).toMatchObject([{ reason: { code: 'report_already_handled' } }])
  expect(await env.balance()).toBe(1007)
  expect((await env.ledger()).map((r) => r.delta)).toEqual([-11, 11, 7])
  expect(await env.events('report.resolved')).toHaveLength(1)
  expect(await env.events('user.roleChanged')).toHaveLength(1)
  const audit = await logs()
  expect(audit.map((r) => r.action).sort()).toEqual(['report.resolve', 'user.setRole'])
  const winnerIp = results[0].status === 'fulfilled' ? admin.ip : superadmin.ip
  expect(audit.every((r) => r.ip === winnerIp)).toBe(true)
  await consistent()
})

test('管理员从举报删除：收藏者按实付退还，上传者不退，其余举报各自采纳并记审计', async () => {
  const tid = await paidTexture()
  const other = await env.user('other')
  await env.setting('score.perClosetItem', 4)
  await env.core.closet.add(env.actor, { tid })
  const a = await env.core.reports.create(env.actor, { tid, reason: 'A' })
  await env.setting('report.cost', 13)
  const b = await env.core.reports.create(other, { tid, reason: 'B' })
  await env.setting('score.perClosetItem', 50)
  await env.setting('report.cost', 80)
  expect(await env.core.admin.textureDeletionImpact(admin.uid, tid)).toEqual({ likes: 1, pendingReports: 2 })
  expect(await env.core.admin.resolveReport(admin, a.id, 'deleteTexture')).toMatchObject({
    status: 'resolved',
    resolution: 'textureDeleted',
    texture: null,
    resolver: { uid: admin.uid },
  })
  expect(await env.balance()).toBe(1007)
  expect(await env.balance(other.uid)).toBe(1007)
  expect(await env.balance(env.owner.uid)).toBe(975)
  expect(await countRows(env.db().selectFrom('reports').where('status', '=', 'pending'))).toBe(0)
  expect(await env.events('report.resolved')).toHaveLength(2)
  const audit = await logs()
  expect(audit).toHaveLength(3)
  expect(audit.every((r) => r.ip === admin.ip)).toBe(true)
  // 经由的这条举报和其余待处理的举报一起，按举报人 uid 升序结算（加锁顺序，docs/schema.md）
  expect(env.actor.uid).toBeLessThan(other.uid)
  const reportLogs = audit.filter((r) => r.action === 'report.resolve')
  expect(reportLogs.map((r) => JSON.parse(r.details) as unknown)).toEqual([
    { action: 'deleteTexture', tid, refunded: 11, rewarded: 7 },
    { action: 'deleteTexture', tid, refunded: 13, rewarded: 7 },
  ])
  expect(reportLogs.map((r) => r.subject_id)).toEqual([a.id, b.id])
  expect(JSON.parse(audit.find((r) => r.action === 'texture.delete')!.details)).toMatchObject({
    uploaderId: env.owner.uid,
    reportId: a.id,
  })
  await consistent()
})

test('管理员直接删除私有材质仍结案所有举报；删除材质不受上传者角色限制', async () => {
  const tid = await env.texture()
  await env.core.reports.create(env.actor, { tid, reason: 'A' })
  await env.core.textures.update(env.owner, tid, { public: false })
  await role(env.owner.uid, 'superadmin')
  expect(await env.core.admin.deleteTexture(admin, tid)).toEqual({ resolvedReports: 1 })
  expect((await logs()).map((r) => r.action)).toEqual(['report.resolve', 'texture.delete'])
  await expect(env.core.admin.deleteTexture(admin, tid)).rejects.toMatchObject({ code: 'texture_not_found' })
  expect(await env.core.admin.textureDeletionImpact(admin.uid, tid)).toBeNull()
  await consistent()
})

test('上传者自删：存储费照旧退，举报只退不奖、无处理人、无审计', async () => {
  const tid = await paidTexture()
  const report = await env.core.reports.create(env.actor, { tid, reason: 'A' })
  expect(await env.core.textures.delete(env.owner, tid)).toEqual({ refunded: 25 })
  expect(await env.balance()).toBe(1000)
  expect(await env.balance(env.owner.uid)).toBe(1000)
  expect(
    await env.db().selectFrom('reports').selectAll().where('id', '=', report.id).executeTakeFirstOrThrow(),
  ).toMatchObject({ status: 'resolved', resolution: 'textureDeleted', resolver_id: null, texture_id: null })
  expect(await env.events('report.resolved')).toHaveLength(1)
  expect(await logs()).toEqual([])
  await consistent()
})

test('删除账号的私有材质：他人只退不奖，被删账号自己的举报不结算', async () => {
  const tid = await env.texture()
  await env.core.reports.create(env.actor, { tid, reason: 'A' })
  await env.core.reports.create(env.owner, { tid, reason: 'B' })
  await env.core.textures.update(env.owner, tid, { public: false })
  await env.core.users.deleteAccount(env.owner, await credential(env.owner.uid))
  const reports = await env.db().selectFrom('reports').selectAll().execute()
  expect(reports).toHaveLength(2)
  expect(reports.every((r) => r.status === 'resolved' && r.resolver_id === null && r.texture_id === null)).toBe(true)
  expect(await env.balance()).toBe(1000)
  expect(await env.events('report.resolved')).toHaveLength(2)
  expect(await logs()).toEqual([])
  await consistent()
})

test('角色顺序、不能改自己、禁止接口设 superadmin、撤职后重新检查数据库角色', async () => {
  await expect(env.core.admin.setRole(admin, superadmin.uid, 'banned')).rejects.toMatchObject({
    code: 'user_not_manageable',
  })
  const peer = await env.user('peer')
  await role(peer.uid, 'admin')
  await expect(env.core.admin.setRole(admin, peer.uid, 'banned')).rejects.toMatchObject({ code: 'user_not_manageable' })
  for (const actor of [admin, superadmin])
    await expect(env.core.admin.setRole(actor, actor.uid, 'user')).rejects.toMatchObject({
      code: 'user_not_manageable',
    })
  await expect(env.core.admin.setRole(admin, env.actor.uid, 'admin')).rejects.toMatchObject({
    code: 'permission_denied',
  })
  await expect(env.core.admin.setRole(superadmin, env.actor.uid, 'superadmin' as AssignableRole)).rejects.toMatchObject(
    { code: 'invalid_request' },
  )
  expect(await env.core.admin.setRole(superadmin, peer.uid, 'banned')).toMatchObject({ role: 'banned' })
  expect(await env.core.admin.setRole(admin, peer.uid, 'user')).toMatchObject({ role: 'user' })
  await env.core.admin.setRole(superadmin, admin.uid, 'user')
  await expect(env.core.admin.deleteTexture(admin, await env.texture())).rejects.toMatchObject({
    code: 'permission_denied',
  })
  await expect(env.core.admin.resolveReport(admin, 1, 'dismiss')).rejects.toMatchObject({ code: 'permission_denied' })
  await expect(env.core.admin.setRole(admin, env.actor.uid, 'banned')).rejects.toMatchObject({
    code: 'permission_denied',
  })
  expect((await logs()).every((r) => r.ip !== null)).toBe(true)
})

test('角色未变化不记事件或审计；system 可以任命超级管理员并记录空 IP', async () => {
  expect(await env.core.admin.setRole(admin, env.actor.uid, 'user')).toMatchObject({ role: 'user' })
  expect(await logs()).toEqual([])
  expect(await env.events('user.roleChanged')).toEqual([])
  expect(await env.core.admin.setRoleAsSystem(' ACTOR@EXAMPLE.TEST ', 'superadmin')).toMatchObject({
    role: 'superadmin',
  })
  expect(await logs()).toMatchObject([{ actor_type: 'system', actor_user_id: null, ip: null, action: 'user.setRole' }])
  expect(await env.events('user.roleChanged')).toMatchObject([
    { actor: { kind: 'system' }, data: { from: 'user', to: 'superadmin' } },
  ])
  await env.core.admin.setRoleAsSystem('actor@example.test', 'superadmin')
  expect(await logs()).toHaveLength(1)
  await expect(env.core.admin.setRoleAsSystem('missing@example.test', 'admin')).rejects.toMatchObject({
    code: 'user_not_found',
  })
  await expect(env.core.admin.setRole(admin, 2147483647, 'user')).rejects.toMatchObject({ code: 'user_not_found' })
})

test('驳回不退不奖；已经 banned 的上传者仍采纳，不重复发角色事件', async () => {
  const tid = await env.texture()
  const a = await env.core.reports.create(env.actor, { tid, reason: 'A' })
  expect(await env.core.admin.resolveReport(admin, a.id, 'dismiss')).toMatchObject({
    status: 'rejected',
    resolution: 'dismissed',
  })
  expect(await env.balance()).toBe(989)
  expect(JSON.parse((await logs())[0]!.details)).toEqual({ action: 'dismiss', tid, refunded: 0, rewarded: 0 })
  await role(env.owner.uid, 'banned')
  const b = await env.core.reports.create(env.actor, { tid: await env.texture(), reason: 'B' })
  await env.core.admin.resolveReport(admin, b.id, 'banUploader')
  expect(await env.events('user.roleChanged')).toEqual([])
  await expect(env.core.admin.resolveReport(admin, b.id, 'dismiss')).rejects.toMatchObject({
    code: 'report_already_handled',
  })
  await expect(env.core.admin.resolveReport(admin, 2147483647, 'dismiss')).rejects.toMatchObject({
    code: 'report_not_found',
  })
  await consistent()
})

test('上传者注销不能封禁；举报人注销后不退不奖；失败不会留下审计', async () => {
  const tid = await env.texture()
  const report = await env.core.reports.create(env.actor, { tid, reason: 'A' })
  await env.core.users.deleteAccount(env.owner, await credential(env.owner.uid))
  await expect(env.core.admin.resolveReport(admin, report.id, 'banUploader')).rejects.toMatchObject({
    code: 'user_not_found',
  })
  expect(await logs()).toEqual([])
  await env.core.users.deleteAccount(env.actor, await credential(env.actor.uid))
  await env.core.admin.resolveReport(admin, report.id, 'deleteTexture')
  expect(JSON.parse((await logs()).find((r) => r.action === 'report.resolve')!.details)).toMatchObject({
    refunded: 0,
    rewarded: 0,
  })
  await consistent()
})

test('业务完成后提交失败，角色、举报、积分、事件和审计整体回滚', async () => {
  const report = await env.core.reports.create(env.actor, { tid: await env.texture(), reason: 'A' })
  const transaction = env.db().transaction.bind(env.db())
  const spy = vi.spyOn(env.db(), 'transaction').mockImplementation(() => {
    const builder = transaction(),
      execute = builder.execute.bind(builder)
    builder.execute = (run) =>
      execute(async (tx) => {
        await run(tx)
        expect(await countRows(tx.selectFrom('audit_logs'))).toBe(2)
        throw new Error('模拟提交失败')
      })
    return builder
  })
  try {
    await expect(env.core.admin.resolveReport(admin, report.id, 'banUploader')).rejects.toThrow('模拟提交失败')
  } finally {
    spy.mockRestore()
  }
  expect(await logs()).toEqual([])
  expect(await env.events('report.resolved')).toEqual([])
  expect(await env.events('user.roleChanged')).toEqual([])
  expect(await env.balance()).toBe(989)
  expect(
    await env.db().selectFrom('reports').select('status').where('id', '=', report.id).executeTakeFirstOrThrow(),
  ).toEqual({ status: 'pending' })
  expect(
    await env.db().selectFrom('users').select('role').where('id', '=', env.owner.uid).executeTakeFirstOrThrow(),
  ).toEqual({ role: 'user' })
  await consistent()
})

test('所有后台查询检查数据库角色，impact 对无权限用户返回 null', async () => {
  for (const roleValue of ['user', 'banned'] as const) {
    await role(env.actor.uid, roleValue)
    for (const run of [
      () => env.core.admin.overview(env.actor.uid),
      () => env.core.admin.listReports(env.actor.uid, { status: 'pending', page: 1 }),
      () => env.core.admin.listUsers(env.actor.uid, { page: 1 }),
      () => env.core.admin.listAudit(env.actor.uid, { page: 1 }),
    ])
      await expect(run()).rejects.toMatchObject({ code: 'permission_denied' })
    expect(await env.core.admin.textureDeletionImpact(env.actor.uid, await env.texture())).toBeNull()
  }
})

test('后台查询：私有材质、举报排序和分组总数、用户包含匹配与 LIKE 转义', async () => {
  const first = await env.texture(),
    second = await env.texture()
  const a = await env.core.reports.create(env.actor, { tid: first, reason: 'A' })
  const b = await env.core.reports.create(env.actor, { tid: second, reason: 'B' })
  await env.core.textures.update(env.owner, first, { public: false })
  expect(await env.core.admin.listReports(admin.uid, { status: 'pending', page: 0, perPage: 0 })).toMatchObject({
    items: [
      {
        id: a.id,
        texture: { tid: first, public: false },
        uploader: { uid: env.owner.uid },
        reporter: { uid: env.actor.uid },
      },
    ],
    total: 2,
    counts: { pending: 2, resolved: 0, rejected: 0 },
  })
  expect(await env.core.admin.listReports(admin.uid, { status: 'pending', page: 2, perPage: 1 })).toMatchObject({
    items: [{ id: b.id }],
    total: 2,
  })
  await env.core.admin.resolveReport(admin, a.id, 'dismiss')
  await env.core.admin.resolveReport(admin, b.id, 'dismiss')
  expect(await env.core.admin.listReports(admin.uid, { status: 'rejected', page: 1 })).toMatchObject({
    items: [{ id: b.id }, { id: a.id }],
    counts: { pending: 0, resolved: 0, rejected: 2 },
  })
  await env.db().updateTable('users').set({ nickname: 'MiXeD%_!\\' }).where('id', '=', env.actor.uid).execute()
  for (const q of ['mixed', 'ACTOR@EXAMPLE', '%_!\\', String(env.actor.uid)]) {
    expect(await env.core.admin.listUsers(admin.uid, { q, page: 1 })).toMatchObject({
      total: 1,
      items: [{ uid: env.actor.uid }],
    })
  }
  expect(await env.core.admin.listUsers(admin.uid, { q: 'no match', page: 1 })).toEqual({ total: 0, items: [] })
  expect(await env.core.admin.listUsers(admin.uid, { role: 'admin', page: 1 })).toMatchObject({
    total: 1,
    items: [{ uid: admin.uid }],
  })
  const page = await env.core.admin.listUsers(admin.uid, { page: 1, perPage: 1 })
  expect(page.items.map((u) => u.uid)).toEqual([superadmin.uid])
})

test('头像沿用可见性和倍率规则；审计过滤、JSON、对象存在性及已删除操作者', async () => {
  const tid = await env.texture()
  await env.core.users.updateProfile(env.actor, { avatar: tid })
  expect((await env.core.admin.listUsers(admin.uid, { q: String(env.actor.uid), page: 1 })).items[0]?.avatar).toEqual({
    hash: (await env.core.textures.detail(env.actor.uid, tid))!.hash,
    scale: 1,
  })
  await env.core.admin.setRole(admin, env.actor.uid, 'banned')
  const audit = await env.core.admin.listAudit(admin.uid, {
    subjectType: 'user',
    subjectId: env.actor.uid,
    actorUid: admin.uid,
    page: 1,
  })
  expect(audit).toMatchObject({
    total: 1,
    items: [
      {
        actor: { type: 'user', uid: admin.uid, nickname: 'admin' },
        subject: { type: 'user', id: env.actor.uid, exists: true },
        details: { from: 'user', to: 'banned', nickname: 'actor' },
        ip: admin.ip,
      },
    ],
  })
  await env.core.admin.deleteTexture(admin, tid)
  expect(await env.core.admin.listAudit(admin.uid, { subjectType: 'texture', subjectId: tid, page: 1 })).toMatchObject({
    total: 1,
    items: [{ subject: { exists: false }, details: { name: 'Texture' } }],
  })
  expect((await env.core.admin.listUsers(admin.uid, { q: String(env.actor.uid), page: 1 })).items[0]?.avatar).toBeNull()
  await env.db().deleteFrom('users').where('id', '=', admin.uid).execute()
  await env.db().deleteFrom('users').where('id', '=', env.actor.uid).execute()
  expect(
    await env.core.admin.listAudit(superadmin.uid, { subjectType: 'user', subjectId: env.actor.uid, page: 1 }),
  ).toMatchObject({ items: [{ actor: { type: 'user', uid: admin.uid, nickname: null }, subject: { exists: false } }] })
})

test('概览按站点时区计算今天，审计最近十条倒序；系统和插件操作者', async () => {
  await env.setting('site.timeZone', 'America/New_York')
  const before = await env.user('yesterday'),
    today = await env.user('today')
  await env
    .db()
    .updateTable('users')
    .set({ created_at: writeAuthDate(env.db(), toIsoTimestamp(new Date('2026-10-17T03:59:59.999Z'))) })
    .where('id', '=', before.uid)
    .execute()
  await env
    .db()
    .updateTable('users')
    .set({ created_at: writeAuthDate(env.db(), toIsoTimestamp(new Date('2026-10-17T04:00:00.000Z'))) })
    .where('id', '=', today.uid)
    .execute()
  const tid = await env.texture()
  await env.core.reports.create(env.actor, { tid, reason: 'A' })
  for (let i = 0; i < 12; i++) await env.core.admin.setRoleAsSystem('today@example.test', i % 2 ? 'user' : 'admin')
  const overview = await env.core.admin.overview(admin.uid)
  expect(overview).toMatchObject({ pendingReports: 1, users: 6, textures: 1, registeredToday: 1 })
  expect(overview.recentAudit).toHaveLength(10)
  expect(overview.recentAudit[0]?.actor).toEqual({ type: 'system' })
  expect(overview.recentAudit[0]!.id).toBeGreaterThan(overview.recentAudit[9]!.id)
  await env
    .db()
    .insertInto('audit_logs')
    .values({
      actor_type: 'plugin',
      actor_plugin_id: 'test-plugin',
      action: 'future.action',
      subject_type: 'future',
      subject_id: 1,
      details: '{}',
      created_at: env.now(),
    })
    .execute()
  expect(await env.core.admin.listAudit(admin.uid, { page: 1, perPage: 1 })).toMatchObject({
    total: 13,
    items: [
      {
        actor: { type: 'plugin', pluginId: 'test-plugin' },
        subject: { type: 'future', id: 1, exists: false },
        details: {},
      },
    ],
  })
})

test('封禁上传者遵守角色顺序，拒绝时举报与审计都回滚', async () => {
  await role(env.owner.uid, 'admin')
  const report = await env.core.reports.create(env.actor, { tid: await env.texture(), reason: 'A' })
  await expect(env.core.admin.resolveReport(admin, report.id, 'banUploader')).rejects.toMatchObject({
    code: 'user_not_manageable',
  })
  expect(await logs()).toEqual([])
  expect(await env.balance()).toBe(989)
  expect((await env.core.admin.listReports(admin.uid, { status: 'pending', page: 1 })).total).toBe(1)
  await env.core.admin.resolveReport(superadmin, report.id, 'banUploader')
  expect(await env.balance()).toBe(1007)
  await consistent()
})

test('关闭删除退款不影响举报实付退还；零奖励不写奖励流水', async () => {
  const tid = await paidTexture()
  await env.setting('score.perClosetItem', 4)
  await env.core.closet.add(env.actor, { tid })
  await env.core.reports.create(env.actor, { tid, reason: 'A' })
  await env.setting('score.refundOnDelete', false)
  await env.setting('report.reward', 0)
  await env.core.admin.deleteTexture(admin, tid)
  expect(await env.balance()).toBe(996)
  expect(await env.balance(env.owner.uid)).toBe(975)
  expect((await env.ledger()).map((r) => r.delta)).toEqual([-4, -11, 11])
  await consistent()
})

test('上传者删除与管理员处理竞争时仍只结案一次，按先提交的删除路径退款', async () => {
  const tid = await env.texture()
  const report = await env.core.reports.create(env.actor, { tid, reason: 'A' })
  const pause = env.pauseNextCommit()
  const leading = env.core.textures.delete(env.owner, tid)
  let trailing: Promise<unknown> | undefined
  try {
    await pause.entered
    trailing = env.core.admin.resolveReport(admin, report.id, 'deleteTexture').catch((error: unknown) => error)
    await pause.contended
    pause.resume()
    await leading
    expect(await trailing).toMatchObject({ code: 'report_already_handled' })
    expect(await env.balance()).toBe(1000)
    expect(await env.events('report.resolved')).toHaveLength(1)
    expect(await logs()).toEqual([])
    await consistent()
  } finally {
    pause.resume()
    await leading
    await trailing
    pause.restore()
  }
})

test('经由举报删除材质时按举报人 uid 升序结算：经由的举报是 uid 较大的那个人的', async () => {
  const tid = await env.texture()
  const other = await env.user('other')
  const first = await env.core.reports.create(env.actor, { tid, reason: '先' })
  const second = await env.core.reports.create(other, { tid, reason: '后' })
  expect(env.actor.uid).toBeLessThan(other.uid)
  await env.core.admin.resolveReport(admin, second.id, 'deleteTexture')
  const refunds = await env
    .db()
    .selectFrom('score_transactions')
    .select(['user_id', 'subject_id'])
    .where('reason', '=', 'score.reasons.reportRefunded')
    .orderBy('id')
    .execute()
  expect(refunds).toEqual([
    { user_id: env.actor.uid, subject_id: first.id },
    { user_id: other.uid, subject_id: second.id },
  ])
  await consistent()
})

test('处理人注销之后，从审计记录找回处理人；上传者自删的举报没有处理人', async () => {
  const tid = await env.texture()
  const handled = await env.core.reports.create(env.actor, { tid, reason: '管理员删的' })
  const helper = { ...(await env.user('helper')), ip: null }
  await role(helper.uid, 'admin')
  await env.core.admin.resolveReport(helper, handled.id, 'deleteTexture')
  await role(helper.uid, 'user')
  await env.core.users.deleteAccount(helper, await credential(helper.uid))
  const own = await env.texture()
  const selfDeleted = await env.core.reports.create(env.actor, { tid: own, reason: '上传者自己删的' })
  await env.core.textures.delete(env.owner, own)
  const { items } = await env.core.admin.listReports(admin.uid, { status: 'resolved', page: 1 })
  expect(items.find((r) => r.id === handled.id)).toMatchObject({
    resolution: 'textureDeleted',
    resolver: { uid: helper.uid, nickname: null },
  })
  expect(items.find((r) => r.id === selfDeleted.id)).toMatchObject({ resolution: 'textureDeleted', resolver: null })
})
