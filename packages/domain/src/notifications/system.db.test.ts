import { beforeEach, expect, test, vi } from 'vitest'
import { setup } from '../closet/test-support.ts'
import { notifyAccountChanged } from '../admin/notify.ts'
import * as auditModule from '../audit/write.ts'
import { MAIL_JOB } from '../mail/service.ts'

const env = setup()
let admin: { uid: number; ip: null }
beforeEach(async () => {
  admin = { ...(await env.user('admin')), ip: null }
  await env.db().updateTable('users').set({ role: 'admin' }).where('id', '=', admin.uid).execute()
  await env.setting('report.cost', 11)
  await env.setting('report.reward', 7)
})
async function notices(uid: number, type?: string) {
  let query = env.db().selectFrom('notifications').selectAll().where('user_id', '=', uid)
  if (type) query = query.where('type', '=', type)
  return (await query.orderBy('id').execute()).map((row) => ({
    ...row,
    params: JSON.parse(row.params!) as Record<string, unknown>,
  }))
}

test.each(['dismiss', 'banUploader', 'deleteTexture'] as const)(
  '举报 %s 在业务事务中通知举报人，所有结果带材质名和退奖',
  async (action) => {
    const tid = await env.texture('steve', true, '材质名')
    const report = await env.core.reports.create(env.actor, { tid, reason: '违规' })
    expect(await notices(admin.uid, 'report.pending')).toHaveLength(1)
    await env.core.admin.resolveReport(admin, report.id, action)
    expect(await notices(env.actor.uid, 'report.resolved')).toMatchObject([
      {
        params: {
          reportId: report.id,
          tid,
          textureName: '材质名',
          outcome: action === 'dismiss' ? 'rejected' : 'resolved',
          refunded: action === 'dismiss' ? 0 : 11,
          rewarded: action === 'dismiss' ? 0 : 7,
        },
      },
    ])
    expect(await notices(env.owner.uid, 'texture.removed')).toHaveLength(action === 'deleteTexture' ? 1 : 0)
  },
)

test('管理员直接删除时连带结案也带快照，自删结案通知举报人但不通知上传者', async () => {
  const tid = await env.texture('steve', true, '删除前名字')
  const report = await env.core.reports.create(env.actor, { tid, reason: '违规' })
  await env.core.admin.deleteTexture(admin, tid)
  expect(await notices(env.owner.uid, 'texture.removed')).toMatchObject([
    { params: { tid, name: '删除前名字', action: 'deleted' } },
  ])
  expect(await notices(env.actor.uid, 'report.resolved')).toMatchObject([
    { params: { reportId: report.id, textureName: '删除前名字', refunded: 11, rewarded: 7 } },
  ])
  const other = await env.texture()
  await env.core.reports.create(env.actor, { tid: other, reason: '违规' })
  await env.core.textures.delete(env.owner, other)
  expect(await notices(env.owner.uid, 'texture.removed')).toHaveLength(1)
  expect((await notices(env.actor.uid, 'report.resolved')).at(-1)!.params).toMatchObject({ tid: other, rewarded: 0 })
})

test('管理员操作自己的删除和删除用户连同材质均不写 texture.removed', async () => {
  const own = await env.texture()
  await env.db().updateTable('textures').set({ uploader_id: admin.uid }).where('id', '=', own).execute()
  await env.core.admin.deleteTexture(admin, own)
  expect(await notices(admin.uid, 'texture.removed')).toEqual([])
  await env.texture()
  await env.core.admin.deleteUser(admin, env.owner.uid, { publicTextures: 'delete' })
  expect(
    await env.db().selectFrom('notifications').select('id').where('type', '=', 'texture.removed').execute(),
  ).toEqual([])
})

test('下架只通知仍存在的上传者一次，已私有不重复，自有材质拒绝操作', async () => {
  const tid = await env.texture('steve', true, '下架名')
  await env.core.admin.unpublishTexture(admin, tid)
  await env.core.admin.unpublishTexture(admin, tid)
  expect(await notices(env.owner.uid, 'texture.removed')).toMatchObject([
    { params: { tid, name: '下架名', action: 'unpublished' } },
  ])
  const own = await env.texture()
  await env.db().updateTable('textures').set({ uploader_id: admin.uid }).where('id', '=', own).execute()
  await expect(env.core.admin.unpublishTexture(admin, own)).rejects.toMatchObject({ code: 'admin_own_texture' })
  expect(await notices(admin.uid, 'texture.removed')).toEqual([])
})

test('提交举报的管理员不给自己写待处理提示，其他管理员未读去重；业务失败和回滚不留下通知', async () => {
  const other = await env.user('otherAdmin')
  await env.db().updateTable('users').set({ role: 'superadmin' }).where('id', '=', other.uid).execute()
  await env.core.reports.create(admin, { tid: await env.texture(), reason: '违规' })
  expect(await notices(admin.uid, 'report.pending')).toEqual([])
  await env.core.reports.create(env.actor, { tid: await env.texture(), reason: '违规' })
  expect(await notices(other.uid, 'report.pending')).toHaveLength(1)
  await env.setting('report.cost', 10000)
  await expect(env.core.reports.create(env.actor, { tid: await env.texture(), reason: '违规' })).rejects.toMatchObject({
    code: 'score_insufficient',
  })
  expect(await notices(other.uid, 'report.pending')).toHaveLength(1)
  const tid = await env.texture()
  const failure = vi.spyOn(auditModule, 'audit').mockRejectedValueOnce(new Error('rollback'))
  try {
    await expect(env.core.admin.unpublishTexture(admin, tid)).rejects.toThrow('rollback')
  } finally {
    failure.mockRestore()
  }
  expect(await notices(env.owner.uid, 'texture.removed')).toEqual([])
  expect(
    (await env.db().selectFrom('textures').select('is_public').where('id', '=', tid).executeTakeFirstOrThrow())
      .is_public,
  ).toBe(1)
})

test('未配置邮件的账号改动仍写站内通知，绑定存 ID 不存译名；空改动和已注销用户不写', async () => {
  await env.core.admin.disableUserTwoFactor(admin, env.actor.uid)
  expect(await notices(env.actor.uid, 'account.changed')).toEqual([])
  await env.db().updateTable('users').set({ two_factor_enabled: true }).where('id', '=', env.actor.uid).execute()
  await env.core.admin.disableUserTwoFactor(admin, env.actor.uid)
  expect(await notices(env.actor.uid, 'account.changed')).toMatchObject([
    { params: { changes: [{ kind: 'twoFactor' }] } },
  ])
  // 没有配置邮件时改邮箱当场生效，也要告诉用户
  await env.core.admin.changeUserEmail(admin, env.actor.uid, { email: 'moved@example.test' }, 'http://localhost')
  expect((await notices(env.actor.uid, 'account.changed')).at(-1)).toMatchObject({
    params: { changes: [{ kind: 'email', pending: false }] },
  })
  const input = {
    uid: env.actor.uid,
    to: 'recipient@example.test',
    at: env.now(),
    changes: [{ kind: 'binding' as const, pluginId: 'example', providerId: 'github', provider: '翻译好的名称' }],
  }
  await env
    .db()
    .transaction()
    .execute((tx) => notifyAccountChanged(tx, env.core.jobs, { configured: true, siteLocale: 'zh-CN' }, input))
  expect((await notices(env.actor.uid, 'account.changed')).at(-1)!.params).toEqual({
    changes: [{ kind: 'binding', pluginId: 'example', providerId: 'github' }],
  })
  const mail = await env.db().selectFrom('jobs').select('payload').where('name', '=', MAIL_JOB).execute()
  expect(mail).toHaveLength(1)
  expect(JSON.parse(mail[0]!.payload)).toMatchObject({ changes: [{ kind: 'binding', provider: '翻译好的名称' }] })
  await env
    .db()
    .transaction()
    .execute(async (tx) => {
      await notifyAccountChanged(
        tx,
        env.core.jobs,
        { configured: false, siteLocale: 'zh-CN' },
        { ...input, changes: [] },
      )
      await notifyAccountChanged(
        tx,
        env.core.jobs,
        { configured: false, siteLocale: 'zh-CN' },
        { ...input, uid: 2147483647 },
      )
    })
  expect(await notices(env.actor.uid, 'account.changed')).toHaveLength(3)
})
