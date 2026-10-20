import { randomUUID } from 'node:crypto'
import { insertReturningId, toIsoTimestamp, writeAuthDate, type CoreDatabase } from '@nextskin/db'
import type { Insertable } from 'kysely'
import { afterEach, expect, test } from 'vitest'
import { sha256 } from '../auth/auth.ts'
import { JOIN_SCOPE, playerReference, SELECT_SCOPE } from '../oauth/scopes.ts'
import { encodeTexturePng } from '../textures/image.ts'
import { email, password, setup } from './yggdrasil.test-helper.ts'

const s = setup()
const clients: string[] = []
const date = (offset = 0) => writeAuthDate(s.db(), toIsoTimestamp(new Date(s.now().getTime() + offset)))
const validate = (accessToken: string, clientToken: string | null = null) =>
  s.core.yggdrasil.validate({ accessToken, clientToken })
const join = (accessToken: string, selectedProfile: string) =>
  s.core.yggdrasil.join({ accessToken, selectedProfile, ip: null, serverId: 'oauth-server' })
const failure = (code: string, kind = 'ForbiddenOperationException') => ({
  kind,
  messageKey: `yggdrasil.errors.${code}`,
})

async function oauth(
  pid: number,
  overrides: Partial<Insertable<CoreDatabase['oauth_access_tokens']>> = {},
  withRefresh = true,
) {
  const clientId = overrides.client_id ?? `yggdrasil-test-${randomUUID()}`
  if (overrides.client_id === undefined) {
    clients.push(clientId)
    await s.db().insertInto('oauth_clients').values({ client_id: clientId, redirect_uris: '[]' }).execute()
  }
  const raw = randomUUID()
  const values = {
    user_id: s.uid,
    client_id: clientId,
    scopes: JSON.stringify(['openid', SELECT_SCOPE, JOIN_SCOPE]),
    reference_id: playerReference(pid),
    created_at: date(),
    expires_at: date(60_000),
  }
  const refreshId = withRefresh
    ? await insertReturningId(s.db(), 'oauth_refresh_tokens', { ...values, token: sha256(randomUUID()) })
    : null
  const id = await insertReturningId(s.db(), 'oauth_access_tokens', {
    ...values,
    token: sha256(raw),
    refresh_id: refreshId,
    ...overrides,
  })
  return { raw, id, refreshId, clientId }
}

afterEach(async () => {
  // 只清理本文件建的应用，迁移插入的 shared 必须保留
  if (clients.length) await s.db().deleteFrom('oauth_clients').where('client_id', 'in', clients.splice(0)).execute()
})

test('有效 OAuth 令牌可 validate 和进服，忽略 clientToken，hasJoined 返回绑定角色', async () => {
  const player = await s.player(),
    token = await oauth(player.pid)
  await expect(validate(token.raw, 'arbitrary-client-token')).resolves.toBeUndefined()
  await expect(join(token.raw, 'a'.repeat(32))).rejects.toMatchObject(failure('profile_mismatch'))
  await join(token.raw, player.uuid)
  expect(await s.core.yggdrasil.hasJoined({ username: player.name, serverId: 'oauth-server', ip: null })).toMatchObject(
    { pid: player.pid, uuid: player.uuid },
  )
})

test.each([
  'revoked',
  'expired',
  'expiry-boundary',
  'select-only',
  'no-scopes',
  'unbound',
  'player:0',
  'player:abc',
  'transferred',
  'deleted',
  'disabled',
  'no-user',
  'hash-trailing-space',
] as const)('%s：join、validate 和材质端点返回与无效 authserver 令牌相同的错误', async (condition) => {
  const player = await s.player(),
    launcher = await s.login(),
    token = await oauth(player.pid)
  await s
    .db()
    .updateTable('yggdrasil_tokens')
    .set({ valid_until: toIsoTimestamp(s.now()) })
    .where('access_token_hash', '=', sha256(launcher.accessToken))
    .execute()
  const changes: Partial<Insertable<CoreDatabase['oauth_access_tokens']>> = {}
  if (condition === 'revoked') changes.revoked = date()
  if (condition === 'expired') changes.expires_at = date(-1)
  if (condition === 'expiry-boundary') changes.expires_at = date()
  if (condition === 'select-only') changes.scopes = JSON.stringify(['openid', SELECT_SCOPE])
  if (condition === 'no-scopes') changes.scopes = '[]'
  if (condition === 'unbound') changes.reference_id = null
  if (condition === 'player:0' || condition === 'player:abc') changes.reference_id = condition
  if (condition === 'no-user') changes.user_id = null
  if (condition === 'hash-trailing-space') changes.token = sha256(token.raw) + ' '
  if (Object.keys(changes).length)
    await s.db().updateTable('oauth_access_tokens').set(changes).where('id', '=', token.id).execute()
  if (condition === 'transferred')
    await s
      .db()
      .updateTable('players')
      .set({ user_id: await s.user('new-owner@example.test') })
      .where('id', '=', player.pid)
      .execute()
  // 直接删行，证明读取会拒绝悬空绑定，不依赖另一个切片的主动吊销
  if (condition === 'deleted') await s.db().deleteFrom('players').where('id', '=', player.pid).execute()
  if (condition === 'disabled')
    await s.db().updateTable('oauth_clients').set({ disabled: true }).where('client_id', '=', token.clientId).execute()

  for (const raw of [launcher.accessToken, token.raw]) {
    await expect(validate(raw)).rejects.toMatchObject(failure('token_invalid'))
    await expect(join(raw, player.uuid)).rejects.toMatchObject(failure('token_invalid'))
    for (const operation of ['uploadTexture', 'resetTexture'] as const)
      await expect(
        s.core.yggdrasil[operation]({ accessToken: raw, uuid: player.uuid, type: 'skin', file: null, model: null }),
      ).rejects.toMatchObject(failure('token_unauthorized', 'UnauthorizedException'))
  }
  if (condition !== 'no-user' && condition !== 'hash-trailing-space')
    await expect(validate(token.raw)).rejects.toMatchObject({ locale: 'en' })
})

test('OAuth 到期按注入时钟判断，截止前一毫秒仍可进服和 validate', async () => {
  const player = await s.player(),
    token = await oauth(player.pid)
  s.tick(59_999)
  await validate(token.raw)
  await join(token.raw, player.uuid)
  s.tick(1)
  await expect(validate(token.raw)).rejects.toMatchObject(failure('token_invalid'))
  await expect(join(token.raw, player.uuid)).rejects.toMatchObject(failure('token_invalid'))
})

test('应用停用拒绝已有令牌，再启用后恢复；disabled 为空按未停用处理', async () => {
  const player = await s.player(),
    token = await oauth(player.pid)
  for (const disabled of [true, false, null]) {
    await s.db().updateTable('oauth_clients').set({ disabled }).where('client_id', '=', token.clientId).execute()
    if (disabled) {
      await expect(validate(token.raw)).rejects.toMatchObject(failure('token_invalid'))
      await expect(join(token.raw, player.uuid)).rejects.toMatchObject(failure('token_invalid'))
    } else {
      await validate(token.raw)
      await join(token.raw, player.uuid)
    }
  }
})

test('封禁返回 user_banned，材质用例保留 errors.user_banned，解封后令牌恢复', async () => {
  const player = await s.player(),
    token = await oauth(player.pid)
  await s.db().updateTable('users').set({ role: 'banned' }).where('id', '=', s.uid).execute()
  await expect(validate(token.raw)).rejects.toMatchObject(failure('user_banned'))
  await expect(join(token.raw, player.uuid)).rejects.toMatchObject(failure('user_banned'))
  for (const operation of ['uploadTexture', 'resetTexture'] as const)
    await expect(
      s.core.yggdrasil[operation]({
        accessToken: token.raw,
        uuid: player.uuid,
        type: 'skin',
        file: { bytes: png(), filename: 'skin.png' },
        model: null,
      }),
    ).rejects.toMatchObject({ kind: 'ForbiddenOperationException', messageKey: 'errors.user_banned', locale: 'en' })
  await s.db().updateTable('users').set({ role: 'user' }).where('id', '=', s.uid).execute()
  await validate(token.raw)
  await join(token.raw, player.uuid)
})

test('同哈希同时存在时优先 authserver，clientToken 和失效规则照旧', async () => {
  const player = await s.player(),
    launcher = await s.login({ clientToken: 'launcher-client' })
  await oauth(player.pid, { token: sha256(launcher.accessToken) })
  await expect(validate(launcher.accessToken, 'other')).rejects.toMatchObject(failure('client_token_mismatch'))
  await s
    .db()
    .updateTable('yggdrasil_tokens')
    .set({ valid_until: toIsoTimestamp(s.now()) })
    .where('access_token_hash', '=', sha256(launcher.accessToken))
    .execute()
  await expect(validate(launcher.accessToken)).rejects.toMatchObject(failure('token_invalid'))
  await expect(join(launcher.accessToken, player.uuid)).rejects.toMatchObject(failure('token_invalid'))
})

test('invalidate 幂等，连刷新令牌一起删除，只影响指定令牌组', async () => {
  const player = await s.player(),
    token = await oauth(player.pid),
    other = await oauth(player.pid, { client_id: token.clientId }),
    launcher = await s.login()
  // 同一刷新令牌的访问令牌由外键一起清掉
  const sibling = await oauth(player.pid, { client_id: token.clientId, refresh_id: token.refreshId }, false)
  await s.core.yggdrasil.invalidate({ accessToken: token.raw })
  await s.core.yggdrasil.invalidate({ accessToken: token.raw })
  expect(
    await s.db().selectFrom('oauth_refresh_tokens').select('id').where('id', '=', token.refreshId!).execute(),
  ).toEqual([])
  expect(
    await s.db().selectFrom('oauth_access_tokens').select('id').where('id', 'in', [token.id, sibling.id]).execute(),
  ).toEqual([])
  await validate(other.raw)
  await validate(launcher.accessToken)
  expect(
    await s.db().selectFrom('oauth_refresh_tokens').select('id').where('id', '=', other.refreshId!).execute(),
  ).toHaveLength(1)
})

test.each([true, false])('invalidate 不检查有效性，refresh_id 存在与否：%s', async (withRefresh) => {
  const player = await s.player(),
    token = await oauth(
      player.pid,
      { expires_at: date(-1), revoked: date(), reference_id: null, scopes: '[]' },
      withRefresh,
    )
  await s.db().updateTable('oauth_clients').set({ disabled: true }).where('client_id', '=', token.clientId).execute()
  await s.db().updateTable('users').set({ role: 'banned' }).where('id', '=', s.uid).execute()
  await s.core.yggdrasil.invalidate({ accessToken: token.raw })
  await s.core.yggdrasil.invalidate({ accessToken: token.raw })
  expect(await s.db().selectFrom('oauth_access_tokens').select('id').where('id', '=', token.id).execute()).toEqual([])
  if (token.refreshId !== null)
    expect(
      await s.db().selectFrom('oauth_refresh_tokens').select('id').where('id', '=', token.refreshId).execute(),
    ).toEqual([])
})

test('invalidate 逐字复核 OAuth 哈希，不删除末尾多空格的行', async () => {
  const player = await s.player(),
    token = await oauth(player.pid)
  await s
    .db()
    .updateTable('oauth_access_tokens')
    .set({ token: sha256(token.raw) + ' ' })
    .where('id', '=', token.id)
    .execute()
  await s.core.yggdrasil.invalidate({ accessToken: token.raw })
  expect(await s.db().selectFrom('oauth_access_tokens').select('id').where('id', '=', token.id).execute()).toHaveLength(
    1,
  )
  expect(
    await s.db().selectFrom('oauth_refresh_tokens').select('id').where('id', '=', token.refreshId!).execute(),
  ).toHaveLength(1)
})

test('refresh 拒绝 OAuth 令牌；列表、单个吊销、全部吊销和 signout 只作用于 authserver', async () => {
  const player = await s.player(),
    token = await oauth(player.pid),
    launcher = await s.login()
  for (const accessToken of [token.raw, 'missing-token'])
    await expect(
      s.core.yggdrasil.refresh({ accessToken, selectedProfile: null, clientToken: null, requestUser: false }),
    ).rejects.toMatchObject(failure('token_invalid'))
  const list = await s.core.yggdrasil.listTokens(s.uid)
  expect(list).toHaveLength(1)
  await s.core.yggdrasil.revokeToken(s.uid, list[0]!.id)
  await validate(token.raw)
  await expect(validate(launcher.accessToken)).rejects.toMatchObject(failure('token_invalid'))
  await s.login()
  await s.core.yggdrasil.revokeAllTokens(s.uid)
  await validate(token.raw)
  await s.login()
  await s.core.yggdrasil.signout({ username: email, password, rawPassword: password })
  await validate(token.raw)
  expect(await s.core.yggdrasil.listTokens(s.uid)).toEqual([])
  expect(
    await s.db().selectFrom('oauth_refresh_tokens').select('id').where('id', '=', token.refreshId!).execute(),
  ).toHaveLength(1)
})

function png(height = 64) {
  return encodeTexturePng({ width: 64, height, data: new Uint8Array(64 * height * 4).fill(1) })
}

test.each(['skin', 'cape'])('OAuth 上传和删除 %s 只更改绑定角色的槽位', async (type) => {
  const player = await s.player(),
    token = await oauth(player.pid)
  const input = { accessToken: token.raw, uuid: player.uuid.toUpperCase() + ' ', type }
  await s.core.yggdrasil.uploadTexture({
    ...input,
    file: { bytes: png(type === 'cape' ? 32 : 64), filename: 'skin.png' },
    model: null,
  })
  const slot = type === 'cape' ? 'cape_texture_id' : 'skin_texture_id'
  const row = () => s.db().selectFrom('players').select(slot).where('id', '=', player.pid).executeTakeFirstOrThrow()
  const tid = (await row())[slot]
  expect(tid).not.toBeNull()
  expect(await s.db().selectFrom('closet_items').select('texture_id').where('user_id', '=', s.uid).execute()).toEqual([
    { texture_id: tid },
  ])
  await s.core.yggdrasil.resetTexture(input)
  expect((await row())[slot]).toBeNull()
  expect(await s.db().selectFrom('textures').select('id').where('id', '=', tid!).execute()).toHaveLength(1)
})

test('OAuth 材质授权顺序：401 → 404 → 403 他人 → 403 未绑定 → 400 类型', async () => {
  const player = await s.player(),
    own = await s.player('Alex'),
    foreign = await s.player('Foreign', await s.user('other@example.test')),
    token = await oauth(player.pid)
  const input = { accessToken: token.raw, uuid: player.uuid, type: 'bad', file: null, model: null }
  for (const operation of ['uploadTexture', 'resetTexture'] as const) {
    await expect(s.core.yggdrasil[operation]({ ...input, accessToken: 'invalid', uuid: 'bad' })).rejects.toMatchObject(
      failure('token_unauthorized', 'UnauthorizedException'),
    )
    await expect(s.core.yggdrasil[operation]({ ...input, uuid: 'bad' })).rejects.toMatchObject(
      failure('player_not_found', 'NotFoundException'),
    )
    await expect(s.core.yggdrasil[operation]({ ...input, uuid: foreign.uuid })).rejects.toMatchObject(
      failure('profile_not_owned'),
    )
    await expect(s.core.yggdrasil[operation]({ ...input, uuid: own.uuid })).rejects.toMatchObject({
      ...failure('profile_mismatch'),
      locale: 'en',
    })
    await expect(s.core.yggdrasil[operation](input)).rejects.toMatchObject(
      failure('texture_type_invalid', 'IllegalArgumentException'),
    )
  }
})

test('authserver 未绑定角色时仍能给自己的任意角色上传和删除材质', async () => {
  const first = await s.player(),
    second = await s.player('Alex'),
    launcher = await s.login()
  expect(launcher.selectedProfile).toBeUndefined()
  for (const player of [first, second]) {
    const input = { accessToken: launcher.accessToken, uuid: player.uuid, type: 'skin' }
    await s.core.yggdrasil.uploadTexture({ ...input, file: { bytes: png(), filename: 'skin.png' }, model: null })
    await s.core.yggdrasil.resetTexture(input)
    expect(
      (
        await s
          .db()
          .selectFrom('players')
          .select('skin_texture_id')
          .where('id', '=', player.pid)
          .executeTakeFirstOrThrow()
      ).skin_texture_id,
    ).toBeNull()
  }
})
