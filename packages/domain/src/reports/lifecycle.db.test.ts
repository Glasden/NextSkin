import { insertReturningId, writeAuthDate } from '@nextskin/db'
import { hashPassword } from 'better-auth/crypto'
import { expect, test } from 'vitest'
import { old, setup } from '../closet/test-support.ts'

const env = setup()

test('举报扣实付、记录当前上传者、事务事件与流水，处理后仍不能再举报', async () => {
  const { core, actor, owner } = env
  const tid = await env.texture()
  await env.setting('report.cost', 11)
  await env.setting('report.reward', 50)
  env.subscribe('report.created')
  const report = await core.reports.create(actor, { tid, reason: '  理由😀  ' })
  expect(report).toEqual({
    id: expect.any(Number) as number,
    tid,
    reason: '理由😀',
    status: 'pending',
    scorePaid: 11,
    createdAt: env.now(),
  })
  expect(await env.balance()).toBe(989)
  expect(
    await env.db().selectFrom('reports').selectAll().where('id', '=', report.id).executeTakeFirstOrThrow(),
  ).toMatchObject({ uploader_id: owner.uid, reporter_id: actor.uid, score_paid: 11 })
  expect(await env.events('report.created')).toMatchObject([
    { actor: { kind: 'user', uid: actor.uid, role: 'user' }, data: { reportId: report.id, tid, reporter: actor.uid } },
  ])
  expect(await env.ledger()).toEqual([
    {
      delta: -11,
      reason: 'score.reasons.reportCreated',
      subject_type: 'report',
      subject_id: report.id,
      created_at: env.now(),
    },
  ])
  expect(await core.textures.detail(actor.uid, tid)).toMatchObject({ reported: true, closetItem: null })
  expect(await core.textures.detail(null, tid)).toMatchObject({ reported: false, closetItem: null })
  await env.db().updateTable('reports').set({ status: 'rejected' }).where('id', '=', report.id).execute()
  await expect(core.reports.create(actor, { tid, reason: '再次' })).rejects.toMatchObject({ code: 'report_duplicate' })
  expect(await env.balance()).toBe(989)
  expect(await env.events('report.created')).toHaveLength(1)
  await env.consistent(tid)
})

test('同人并发举报只成功一次、只扣一次；余额不足回滚记录、事件和花费', async () => {
  const { core, actor } = env
  const tid = await env.texture()
  await env.setting('report.cost', 13)
  env.subscribe('report.created')
  const results = await Promise.allSettled([
    core.reports.create(actor, { tid, reason: 'A' }),
    core.reports.create(actor, { tid, reason: 'B' }),
  ])
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter((r) => r.status === 'rejected')).toMatchObject([{ reason: { code: 'report_duplicate' } }])
  expect(await env.balance()).toBe(987)
  expect(await env.ledger()).toHaveLength(1)
  expect(await env.events('report.created')).toHaveLength(1)
  await env.setting('report.cost', 1000)
  await expect(core.reports.create(actor, { tid: await env.texture(), reason: 'X' })).rejects.toMatchObject({
    code: 'score_insufficient',
  })
  expect((await core.reports.listOwn(actor.uid, { page: 1 })).total).toBe(1)
  expect(await env.balance()).toBe(987)
  expect(await env.events('report.created')).toHaveLength(1)
  await env.consistent(tid)
})

test('理由按码点计长并 trim；零费用不记流水；自己私有的也能举报，隐藏他人私有', async () => {
  const { core, actor, owner } = env
  const tid = await env.texture('steve', false)
  for (const reason of [' ', '😀'.repeat(501)])
    await expect(core.reports.create(actor, { tid, reason })).rejects.toMatchObject({
      code: 'report_reason_length',
      params: { min: 1, max: 500 },
    })
  await expect(core.reports.create(actor, { tid, reason: 'X' })).rejects.toMatchObject({ code: 'texture_not_found' })
  // PG 的 text 存不了 U+0000，四种数据库都在写库之前拒绝
  await expect(core.reports.create(owner, { tid, reason: 'a\u0000b' })).rejects.toMatchObject({
    code: 'invalid_request',
  })
  await expect(core.reports.create(actor, { tid: 2147483647, reason: 'X' })).rejects.toMatchObject({
    code: 'texture_not_found',
  })
  const reason = '😀'.repeat(500)
  expect(await core.reports.create(owner, { tid, reason: ` ${reason} ` })).toMatchObject({ reason, scorePaid: 0 })
  expect(await env.ledger(owner.uid)).toEqual([])
})

test('邮箱验证开关与封禁用户', async () => {
  const { core, actor } = env
  const tid = await env.texture()
  await env.db().updateTable('users').set({ email_verified: false }).where('id', '=', actor.uid).execute()
  await env.setting('auth.requireEmailVerification', true)
  await expect(core.reports.create(actor, { tid, reason: 'Reason' })).rejects.toMatchObject({
    code: 'email_not_verified',
  })
  await env.setting('auth.requireEmailVerification', false)
  await core.reports.create(actor, { tid, reason: 'Reason' })
  await env.db().updateTable('users').set({ role: 'banned' }).where('id', '=', actor.uid).execute()
  await expect(core.reports.create(actor, { tid, reason: 'Reason' })).rejects.toMatchObject({ code: 'user_banned' })
})

test('自己的举报按 id 倒序分页；改私有、删除后的材质不泄漏；旧尺寸回退', async () => {
  const { core, actor, owner } = env
  const first = await env.texture(),
    second = await env.texture('cape')
  const a = await core.reports.create(actor, { tid: first, reason: 'First' })
  const b = await core.reports.create(actor, { tid: second, reason: 'Second' })
  await core.reports.create(owner, { tid: first, reason: 'Other reporter' })
  expect(await core.reports.listOwn(actor.uid, { page: 0, perPage: 0 })).toMatchObject({
    total: 2,
    items: [{ id: b.id, texture: { tid: second, type: 'cape', scale: 1 }, resolvedAt: null }],
  })
  expect(await core.reports.listOwn(actor.uid, { page: 2, perPage: 1 })).toMatchObject({
    total: 2,
    items: [{ id: a.id }],
  })
  const detail = await core.textures.detail(actor.uid, first)
  await env.db().updateTable('texture_files').set({ height: 1 }).where('hash', '=', detail!.hash).execute()
  expect((await core.reports.listOwn(actor.uid, { page: 1, perPage: 100 })).items[1]?.texture?.scale).toBe(1)
  await core.textures.update(owner, first, { public: false })
  expect((await core.reports.listOwn(actor.uid, { page: 1 })).items[1]?.texture).toBeNull()
  expect((await core.reports.listOwn(owner.uid, { page: 1 })).items[0]?.texture).toMatchObject({ tid: first })
  await core.textures.delete(owner, second)
  expect(await core.reports.listOwn(actor.uid, { page: 1 })).toMatchObject({
    total: 2,
    items: [
      { id: b.id, texture: null },
      { id: a.id, texture: null },
    ],
  })
})

test('删除举报人、材质、上传者后举报保留，对应外键置空', async () => {
  const { core, actor, owner } = env
  const tid = await env.texture()
  const report = await core.reports.create(actor, { tid, reason: 'Reason' })
  const password = 'password123'
  await env
    .db()
    .insertInto('accounts')
    .values({
      user_id: actor.uid,
      provider_id: 'credential',
      account_id: String(actor.uid),
      password: await hashPassword(password),
      created_at: writeAuthDate(env.db(), old),
      updated_at: writeAuthDate(env.db(), old),
    })
    .execute()
  await core.users.deleteAccount(actor, { password })
  const row = () => env.db().selectFrom('reports').selectAll().where('id', '=', report.id).executeTakeFirstOrThrow()
  expect(await row()).toMatchObject({ reporter_id: null, texture_id: tid, uploader_id: owner.uid })
  await core.textures.delete(owner, tid)
  expect(await row()).toMatchObject({ reporter_id: null, texture_id: null, uploader_id: owner.uid, reason: 'Reason' })
  // 再验证上传者和处理人由外键置空（删除账号用例无需手工清理举报）。
  const resolver = await insertReturningId(env.db(), 'users', {
    nickname: 'resolver',
    email: 'resolver@example.test',
    email_verified: true,
    created_at: writeAuthDate(env.db(), old),
    updated_at: writeAuthDate(env.db(), old),
  })
  await env.db().updateTable('reports').set({ resolver_id: resolver }).where('id', '=', report.id).execute()
  await env.db().deleteFrom('users').where('id', 'in', [owner.uid, resolver]).execute()
  expect(await row()).toMatchObject({ reporter_id: null, texture_id: null, uploader_id: null, resolver_id: null })
})
