import { expect, test, vi } from 'vitest'
import { DomainError } from '../errors.ts'
import { encodeTexturePng } from '../textures/image.ts'
import { setup } from './yggdrasil.test-helper.ts'

const s = setup()
function png(seed = 1, width = 64, height = 64) {
  return encodeTexturePng({ width, height, data: new Uint8Array(width * height * 4).fill(seed) })
}
const balance = async () =>
  (await s.db().selectFrom('users').select('score').where('id', '=', s.uid).executeTakeFirstOrThrow()).score
const row = (pid: number) => s.db().selectFrom('players').selectAll().where('id', '=', pid).executeTakeFirstOrThrow()

test('上传回调只在鉴权和类型检查通过后调用，限额错误保留用户语言且不写材质', async () => {
  const player = await s.player(),
    token = await s.login(),
    other = await s.user('other@example.test'),
    foreign = await s.player('Foreign', other)
  const beforeUpload = vi.fn().mockRejectedValue(new DomainError('too_many_requests', { retryAfter: 12 }))
  const input = {
    accessToken: token.accessToken,
    uuid: player.uuid,
    type: 'skin',
    file: { bytes: png(), filename: 'test.png' },
    model: null,
  }
  for (const invalid of [{ accessToken: null }, { uuid: 'bad' }, { uuid: foreign.uuid }, { type: 'bad' }])
    await expect(s.core.yggdrasil.uploadTexture({ ...input, ...invalid }, beforeUpload)).rejects.toHaveProperty('kind')
  expect(beforeUpload).not.toHaveBeenCalled()
  await expect(s.core.yggdrasil.uploadTexture(input, beforeUpload)).rejects.toMatchObject({
    kind: 'ForbiddenOperationException',
    messageKey: 'errors.too_many_requests',
    params: { retryAfter: 12 },
    locale: 'en',
  })
  expect(beforeUpload).toHaveBeenCalledExactlyOnceWith(s.uid)
  expect(await s.db().selectFrom('textures').select('id').execute()).toEqual([])
  expect((await row(player.pid)).skin_texture_id).toBeNull()
})

test('上传私有皮肤并设置角色；删除只清槽位；UUID 查询遵循规范化规则', async () => {
  const player = await s.player(),
    token = await s.login()
  await s.core.yggdrasil.uploadTexture({
    accessToken: token.accessToken,
    uuid: player.uuid.toUpperCase() + ' ',
    type: 'skin',
    file: { bytes: png(), filename: 'first.png.png' },
    model: 'slim',
  })
  const tid = (await row(player.pid)).skin_texture_id!
  expect(await s.db().selectFrom('textures').selectAll().where('id', '=', tid).executeTakeFirstOrThrow()).toMatchObject(
    { name: 'first.png', type: 'alex', is_public: 0, uploader_id: s.uid },
  )
  expect(await s.db().selectFrom('closet_items').select('texture_id').where('user_id', '=', s.uid).execute()).toEqual([
    { texture_id: tid },
  ])
  await s.core.yggdrasil.resetTexture({ accessToken: token.accessToken, uuid: player.uuid, type: 'skin' })
  expect((await row(player.pid)).skin_texture_id).toBeNull()
  await s.core.yggdrasil.uploadTexture({
    accessToken: token.accessToken,
    uuid: player.uuid,
    type: 'skin',
    file: { bytes: png(2), filename: 'skin.png.backup' },
    model: null,
  })
  expect(
    (
      await s
        .db()
        .selectFrom('textures')
        .select('name')
        .where('id', '=', (await row(player.pid)).skin_texture_id!)
        .executeTakeFirstOrThrow()
    ).name,
  ).toBe('skin.backup')
  expect(await s.db().selectFrom('textures').select('id').where('id', '=', tid).execute()).toHaveLength(1)
})

test('披风上传使用 cape；文件名不合规则时回退角色名', async () => {
  const player = await s.player(),
    token = await s.login()
  await s.setting('texture.nameRegex', '^[A-Za-z]+$')
  await s.core.yggdrasil.uploadTexture({
    accessToken: token.accessToken,
    uuid: player.uuid,
    type: 'cape',
    file: { bytes: png(1, 64, 32), filename: 'invalid 123.png' },
    model: 'slim',
  })
  const tid = (await row(player.pid)).cape_texture_id!
  expect(
    await s.db().selectFrom('textures').select(['name', 'type']).where('id', '=', tid).executeTakeFirstOrThrow(),
  ).toEqual({ name: player.name, type: 'cape' })
  await s.core.yggdrasil.resetTexture({ accessToken: token.accessToken, uuid: player.uuid, type: 'cape' })
  expect((await row(player.pid)).cape_texture_id).toBeNull()
})

test('他人的公开重复图复用并收衣柜费，已在衣柜不重复扣费', async () => {
  const player = await s.player(),
    token = await s.login(),
    other = await s.user('other@example.test')
  const existing = await s.core.textures.upload(
    { uid: other },
    { bytes: png(), name: 'Existing', type: 'steve', public: true },
  )
  await s.setting('score.perClosetItem', 7)
  const before = await balance()
  const input = {
    accessToken: token.accessToken,
    uuid: player.uuid,
    type: 'skin',
    file: { bytes: png(), filename: 'new.png' },
    model: null,
  }
  await s.core.yggdrasil.uploadTexture(input)
  expect((await row(player.pid)).skin_texture_id).toBe(existing.texture.tid)
  expect(await balance()).toBe(before - 7)
  await s.core.yggdrasil.uploadTexture({ ...input, file: { bytes: png(), filename: 'again.png' } })
  expect(await balance()).toBe(before - 7)
  const ledger = await s
    .db()
    .selectFrom('score_transactions')
    .select(['delta', 'reason'])
    .where('user_id', '=', s.uid)
    .where('reason', '!=', 'score.reasons.initial')
    .execute()
  expect(ledger).toEqual([{ delta: -7, reason: 'score.reasons.closetItemAdded' }])
})

test('复用自己的材质但衣柜已移除时仍收衣柜费；模型不同返回 400', async () => {
  const player = await s.player(),
    token = await s.login()
  const existing = await s.core.textures.upload(
    { uid: s.uid },
    { bytes: png(), name: 'Existing', type: 'steve', public: false },
  )
  await s.core.closet.remove({ uid: s.uid }, existing.texture.tid)
  await s.setting('score.perClosetItem', 9)
  const before = await balance()
  await s.core.yggdrasil.uploadTexture({
    accessToken: token.accessToken,
    uuid: player.uuid,
    type: 'skin',
    file: { bytes: png(), filename: 'same.png' },
    model: null,
  })
  expect(await balance()).toBe(before - 9)
  await expect(
    s.core.yggdrasil.uploadTexture({
      accessToken: token.accessToken,
      uuid: player.uuid,
      type: 'skin',
      file: { bytes: png(), filename: 'same.png' },
      model: 'slim',
    }),
  ).rejects.toMatchObject({ kind: 'IllegalArgumentException', messageKey: 'yggdrasil.errors.texture_model_mismatch' })
  expect(await balance()).toBe(before - 9)
})

test('验证顺序：无效令牌 401、未知角色 404、他人角色 403、非法 type 400', async () => {
  const player = await s.player(),
    token = await s.login(),
    other = await s.user('other@example.test'),
    foreign = await s.player('Foreign', other)
  const input = { accessToken: token.accessToken, uuid: player.uuid, type: 'bad', file: null, model: null }
  for (const operation of ['uploadTexture', 'resetTexture'] as const) {
    await expect(s.core.yggdrasil[operation]({ ...input, accessToken: null, uuid: 'bad' })).rejects.toMatchObject({
      kind: 'UnauthorizedException',
      messageKey: 'yggdrasil.errors.token_unauthorized',
    })
    await expect(s.core.yggdrasil[operation]({ ...input, uuid: 'bad' })).rejects.toMatchObject({
      kind: 'NotFoundException',
      messageKey: 'yggdrasil.errors.player_not_found',
    })
    await expect(s.core.yggdrasil[operation]({ ...input, uuid: foreign.uuid })).rejects.toMatchObject({
      kind: 'ForbiddenOperationException',
      messageKey: 'yggdrasil.errors.profile_not_owned',
    })
    await expect(s.core.yggdrasil[operation](input)).rejects.toMatchObject({
      kind: 'IllegalArgumentException',
      messageKey: 'yggdrasil.errors.texture_type_invalid',
      params: { type: 'bad' },
      locale: 'en',
    })
  }
})

test('过期或绑定角色已转让的令牌是 401', async () => {
  await s.setting('yggdrasil.tokenValidSeconds', 1)
  const player = await s.player(),
    token = await s.login()
  s.tick(1000)
  await expect(
    s.core.yggdrasil.resetTexture({ accessToken: token.accessToken, uuid: player.uuid, type: 'skin' }),
  ).rejects.toMatchObject({ kind: 'UnauthorizedException' })
  const fresh = await s.login(),
    uid = await s.user('other@example.test')
  await s.db().updateTable('players').set({ user_id: uid }).where('id', '=', player.pid).execute()
  await expect(
    s.core.yggdrasil.resetTexture({ accessToken: fresh.accessToken, uuid: player.uuid, type: 'skin' }),
  ).rejects.toMatchObject({ kind: 'UnauthorizedException' })
})

test('文件缺失和非法图片包装领域错误，保留语言；余额不足为 403', async () => {
  const player = await s.player(),
    token = await s.login()
  const input = { accessToken: token.accessToken, uuid: player.uuid, type: 'skin', file: null, model: null }
  await expect(s.core.yggdrasil.uploadTexture(input)).rejects.toMatchObject({
    kind: 'IllegalArgumentException',
    messageKey: 'errors.texture_file_invalid',
    locale: 'en',
  })
  await expect(
    s.core.yggdrasil.uploadTexture({ ...input, file: { bytes: new Uint8Array(), filename: 'bad.png' } }),
  ).rejects.toMatchObject({ kind: 'IllegalArgumentException', messageKey: 'errors.texture_file_invalid' })
  await s.setting('score.perKbPrivate', 2147483647)
  await expect(
    s.core.yggdrasil.uploadTexture({ ...input, file: { bytes: png(), filename: 'test.png' } }),
  ).rejects.toMatchObject({ kind: 'ForbiddenOperationException', messageKey: 'errors.score_insufficient' })
})

test('封禁和未验证邮箱由已有用例检查，并包装成 403', async () => {
  const player = await s.player(),
    token = await s.login()
  const input = {
    accessToken: token.accessToken,
    uuid: player.uuid,
    type: 'skin',
    file: { bytes: png(), filename: 'test.png' },
    model: null,
  }
  await s.db().updateTable('users').set({ role: 'banned' }).where('id', '=', s.uid).execute()
  await expect(s.core.yggdrasil.uploadTexture(input)).rejects.toMatchObject({
    kind: 'ForbiddenOperationException',
    messageKey: 'errors.user_banned',
  })
  await expect(s.core.yggdrasil.resetTexture(input)).rejects.toMatchObject({
    kind: 'ForbiddenOperationException',
    messageKey: 'errors.user_banned',
  })
  await s.db().updateTable('users').set({ role: 'user', email_verified: false }).where('id', '=', s.uid).execute()
  await s.setting('auth.requireEmailVerification', true)
  await expect(s.core.yggdrasil.uploadTexture(input)).rejects.toMatchObject({
    kind: 'ForbiddenOperationException',
    messageKey: 'errors.email_not_verified',
  })
})
