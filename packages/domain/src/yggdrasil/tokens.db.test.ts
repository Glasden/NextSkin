import { expect, test, vi } from 'vitest'
import { sha256 } from '../auth/auth.ts'
import { Browser } from '../auth/security.test-helper.ts'
import { YggdrasilError } from './errors.ts'
import { email, password, setup } from './yggdrasil.test-helper.ts'
import { createTokens, userUuid } from './tokens.ts'
import { secretKey } from './yggdrasil.test-helper.ts'
import { definePlugin, deny } from '@nextskin/plugin-sdk'
import type { IssueTokenInterceptor } from '../plugins/system.ts'
import { official } from '../plugins/plugins.test-helper.ts'

const s = setup()
const validate = (accessToken: string | null, clientToken: string | null = null) =>
  s.core.yggdrasil.validate({ accessToken, clientToken })
const refresh = (accessToken: string | null, selectedProfile: unknown = null, clientToken: string | null = null) =>
  s.core.yggdrasil.refresh({ accessToken, selectedProfile, clientToken, requestUser: true })
const failure = (code: string, kind = 'ForbiddenOperationException') => ({
  kind,
  messageKey: `yggdrasil.errors.${code}`,
})

test('uuid5 与 BS 的已知值相同；只存哈希，单角色自动绑定，用户 id 按邮箱算', async () => {
  expect(userUuid(email)).toBe('e35880a4e315561888e869fa38036ef3')
  const player = await s.player()
  const result = await s.login({ requestUser: true, clientToken: 'Client-Token' })
  expect(result).toMatchObject({
    clientToken: 'Client-Token',
    availableProfiles: [{ id: player.uuid, name: 'Steve' }],
    selectedProfile: { id: player.uuid, name: 'Steve' },
    user: { id: userUuid(email), properties: [] },
  })
  expect(result.accessToken).toMatch(/^[a-f0-9]{64}$/)
  const row = await s.db().selectFrom('yggdrasil_tokens').selectAll().executeTakeFirstOrThrow()
  expect(row.access_token_hash).toBe(sha256(result.accessToken))
  expect(Object.values(row)).not.toContain(result.accessToken)
  expect(await s.core.yggdrasil.listTokens(s.uid)).toEqual([
    {
      id: row.id,
      createdAt: row.created_at,
      validUntil: row.valid_until,
      expiresAt: row.expires_at,
      player: { pid: player.pid, name: player.name },
      status: 'valid',
    },
  ])
})

test('零个或多个角色不绑定，所有角色按 id 排序，不要求返回用户', async () => {
  const empty = await s.login()
  expect(empty.availableProfiles).toEqual([])
  expect(empty.selectedProfile).toBeUndefined()
  expect(empty.user).toBeUndefined()
  const z = await s.player('Zulu'),
    a = await s.player('Alpha')
  const result = await s.login()
  expect(result.availableProfiles).toEqual([
    { id: z.uuid, name: z.name },
    { id: a.uuid, name: a.name },
  ])
  expect(result.selectedProfile).toBeUndefined()
  expect(result.clientToken).toMatch(/^[0-9a-f]{32}$/)
})

test('两段过期在等于截止时间时失效；设置改变不影响旧令牌', async () => {
  await s.setting('yggdrasil.tokenValidSeconds', 2)
  await s.setting('yggdrasil.tokenRefreshableSeconds', 4)
  const first = await s.login(),
    second = await s.login()
  await s.setting('yggdrasil.tokenValidSeconds', 20)
  await s.setting('yggdrasil.tokenRefreshableSeconds', 40)
  s.tick(1999)
  await validate(first.accessToken)
  s.tick(1)
  await expect(validate(first.accessToken)).rejects.toMatchObject(failure('token_invalid'))
  expect((await s.core.yggdrasil.listTokens(s.uid)).map((row) => row.status)).toEqual(['refreshable', 'refreshable'])
  const fresh = await refresh(first.accessToken)
  await validate(fresh.accessToken)
  await expect(validate(first.accessToken)).rejects.toMatchObject(failure('token_invalid'))
  s.tick(1999)
  await refresh(second.accessToken)
  const third = await s.login()
  s.tick(40_000)
  await expect(refresh(third.accessToken)).rejects.toMatchObject(failure('token_invalid'))
  await expect(validate(third.accessToken)).rejects.toMatchObject(failure('token_invalid'))
})

test('等于 expires_at 时不能刷新；可刷新期短于有效期时按有效期算', async () => {
  await s.setting('yggdrasil.tokenValidSeconds', 4)
  await s.setting('yggdrasil.tokenRefreshableSeconds', 1)
  const result = await s.login()
  const row = await s.db().selectFrom('yggdrasil_tokens').selectAll().executeTakeFirstOrThrow()
  expect(row.valid_until).toBe(row.expires_at)
  s.tick(3999)
  await validate(result.accessToken)
  s.tick(1)
  await expect(refresh(result.accessToken)).rejects.toMatchObject(failure('token_invalid'))
  expect(await s.core.yggdrasil.listTokens(s.uid)).toEqual([])
})

test('每用户上限按 id 淘汰最早令牌；刷新也裁剪', async () => {
  await s.setting('yggdrasil.tokensPerUser', 2)
  const a = await s.login(),
    b = await s.login(),
    c = await s.login()
  await expect(validate(a.accessToken)).rejects.toMatchObject(failure('token_invalid'))
  await validate(b.accessToken)
  await validate(c.accessToken)
  await s.setting('yggdrasil.tokensPerUser', 1)
  const d = await refresh(b.accessToken)
  await validate(d.accessToken)
  await expect(validate(c.accessToken)).rejects.toMatchObject(failure('token_invalid'))
  expect(await s.core.yggdrasil.listTokens(s.uid)).toHaveLength(1)
})

test('并发刷新同一令牌只有一个成功，失败者返回 token_invalid', async () => {
  const token = await s.login()
  const results = await Promise.all(
    [refresh(token.accessToken), refresh(token.accessToken)].map((operation) =>
      operation.then(
        (value) => value,
        (error: unknown) => error,
      ),
    ),
  )
  expect(results.filter((result) => result instanceof YggdrasilError)).toEqual([
    expect.objectContaining(failure('token_invalid')),
  ])
  expect(results.filter((result) => !(result instanceof Error))).toHaveLength(1)
  expect(await s.core.yggdrasil.listTokens(s.uid)).toHaveLength(1)
})

test('clientToken 可省略，给出时必须逐字相等；invalidate 幂等', async () => {
  const token = await s.login({ clientToken: 'Client' })
  await validate(token.accessToken)
  await expect(validate(token.accessToken, 'client')).rejects.toMatchObject(failure('client_token_mismatch'))
  await expect(refresh(token.accessToken, null, 'Client ')).rejects.toMatchObject(failure('client_token_mismatch'))
  const fresh = await refresh(token.accessToken, null, 'Client')
  expect(fresh.clientToken).toBe('Client')
  await s.core.yggdrasil.invalidate({ accessToken: fresh.accessToken })
  await s.core.yggdrasil.invalidate({ accessToken: fresh.accessToken })
  await s.core.yggdrasil.invalidate({ accessToken: null })
  await expect(validate(fresh.accessToken)).rejects.toMatchObject(failure('token_invalid'))
  await expect(refresh(null)).rejects.toMatchObject(failure('token_invalid'))
})

test('refresh 选角色依次检查名字、已有绑定和归属，成功使用当前名字', async () => {
  const first = await s.player(),
    second = await s.player('Alex')
  const otherUid = await s.user('other@example.test'),
    other = await s.player('Other', otherUid)
  const token = await s.login()
  for (const selected of [true, 'Steve', { name: 12 }, { name: 'missing', id: first.uuid }])
    await expect(refresh(token.accessToken, selected)).rejects.toMatchObject(
      failure('player_not_found', 'IllegalArgumentException'),
    )
  await expect(refresh(token.accessToken, { name: first.name, id: other.uuid })).rejects.toMatchObject(
    failure('profile_not_owned'),
  )
  await expect(refresh(token.accessToken, { name: first.name, id: first.uuid.toUpperCase() })).rejects.toMatchObject(
    failure('profile_not_owned'),
  )
  const bound = await refresh(token.accessToken, { name: 'sTEVE   ', id: second.uuid })
  expect(bound.selectedProfile).toEqual({ id: second.uuid, name: second.name })
  await expect(refresh(bound.accessToken, { name: second.name, id: second.uuid })).rejects.toMatchObject(
    failure('profile_already_bound', 'IllegalArgumentException'),
  )
  const renamed = await s.core.players.update({ uid: s.uid }, second.pid, { name: 'Renamed' })
  const fresh = await refresh(bound.accessToken)
  expect(fresh.selectedProfile).toEqual({ id: second.uuid, name: renamed.name })
})

test('refresh 的空数组、空对象、null、false、0、空字符串均沿用绑定', async () => {
  const player = await s.player()
  let token = await s.login()
  for (const selected of [[], {}, null, false, 0, '', '0']) {
    token = await refresh(token.accessToken, selected)
    expect(token.selectedProfile).toEqual({ id: player.uuid, name: player.name })
  }
})

test('封禁不删令牌，解封后恢复；被封禁或未验证邮箱仍可用密码 signout', async () => {
  const token = await s.login()
  await s.db().updateTable('users').set({ role: 'banned' }).where('id', '=', s.uid).execute()
  await expect(validate(token.accessToken)).rejects.toMatchObject(failure('user_banned'))
  await expect(refresh(token.accessToken)).rejects.toMatchObject(failure('user_banned'))
  await expect(s.login()).rejects.toMatchObject(failure('user_banned'))
  await s.db().updateTable('users').set({ role: 'user', email_verified: false }).where('id', '=', s.uid).execute()
  await validate(token.accessToken)
  await s.setting('auth.requireEmailVerification', true)
  await expect(s.login()).rejects.toMatchObject(failure('email_not_verified'))
  await s.db().updateTable('users').set({ role: 'banned' }).where('id', '=', s.uid).execute()
  await s.core.yggdrasil.signout({ username: email, password, rawPassword: password })
  expect(await s.core.yggdrasil.listTokens(s.uid)).toEqual([])
})

test.each(['player', 'transfer', 'user'] as const)('%s 删除或转让后令牌失效', async (operation) => {
  const player = await s.player(),
    token = await s.login()
  if (operation === 'player') await s.core.players.delete({ uid: s.uid }, player.pid)
  if (operation === 'transfer')
    await s
      .db()
      .updateTable('players')
      .set({ user_id: await s.user('next@example.test') })
      .where('id', '=', player.pid)
      .execute()
  if (operation === 'user') await s.db().deleteFrom('users').where('id', '=', s.uid).execute()
  await expect(validate(token.accessToken)).rejects.toMatchObject(failure('token_invalid'))
  await expect(refresh(token.accessToken)).rejects.toMatchObject(failure('token_invalid'))
  expect(await s.core.yggdrasil.listTokens(s.uid)).toEqual([])
})

test('Better Auth 改密码后删除全部启动器令牌，同事务发密码变更事件', async () => {
  await s.login()
  await s.login()
  const browser = new Browser(s.core)
  expect((await browser.request('/api/auth/sign-in/email', { email, password })).status).toBe(200)
  s.core.events.subscribe('user.profileUpdated', 'test:password', { run: () => Promise.resolve() })
  expect(
    (
      await browser.request('/api/auth/change-password', {
        currentPassword: password,
        newPassword: 'new-password-for-launcher',
      })
    ).status,
  ).toBe(200)
  expect(await s.core.yggdrasil.listTokens(s.uid)).toEqual([])
  const job = await s
    .db()
    .selectFrom('jobs')
    .select('payload')
    .where('name', '=', 'test:password')
    .executeTakeFirstOrThrow()
  expect(JSON.parse(job.payload)).toMatchObject({
    occurredAt: s.now().toISOString(),
    data: { uid: s.uid, fields: ['password'] },
  })
})

test('吊销只作用于自己的令牌，单个和全部吊销均幂等；角色名 signout 吊销该用户全部令牌', async () => {
  await s.player()
  const token = await s.login(),
    otherUid = await s.user('other@example.test')
  const row = (await s.core.yggdrasil.listTokens(s.uid))[0]!
  await s.core.yggdrasil.revokeToken(otherUid, row.id)
  await validate(token.accessToken)
  await s.core.yggdrasil.revokeToken(s.uid, row.id)
  await s.core.yggdrasil.revokeToken(s.uid, row.id)
  await expect(validate(token.accessToken)).rejects.toMatchObject(failure('token_invalid'))
  await s.login()
  await s.core.yggdrasil.revokeAllTokens(s.uid)
  expect(await s.core.yggdrasil.listTokens(s.uid)).toEqual([])
  await s.login()
  await s.core.yggdrasil.signout({ username: 'steve', password, rawPassword: password })
  expect(await s.core.yggdrasil.listTokens(s.uid)).toEqual([])
})

test('核对密码之后、签发之前密码被改了，不签发令牌', async () => {
  const browser = new Browser(s.core)
  expect((await browser.request('/api/auth/sign-in/email', { email, password })).status).toBe(200)
  // 停在核对之后、签发事务之前：签发前会读令牌的设置。Better Auth 每个请求也读这几项（有效期进实例的缓存键，
  // ADR-0037），和站点地址一起读，那一次放行，否则改密码的请求也停在这里
  const read = s.core.settings.read.bind(s.core.settings)
  let release!: () => void
  const paused = new Promise<void>((resolve) => (release = resolve))
  let reached!: () => void
  const atGate = new Promise<void>((resolve) => (reached = resolve))
  const spy = vi.spyOn(s.core.settings, 'read').mockImplementation(async (keys) => {
    const values = await read(keys)
    if (keys.includes('yggdrasil.tokenValidSeconds') && !keys.includes('site.url')) {
      reached()
      await paused
    }
    return values
  })
  try {
    const pending = s.login()
    await atGate
    const changed = await browser.request('/api/auth/change-password', {
      currentPassword: password,
      newPassword: 'changed-while-signing-in',
    })
    expect(changed.status).toBe(200)
    release()
    await expect(pending).rejects.toMatchObject(failure('invalid_credentials'))
  } finally {
    spy.mockRestore()
  }
  expect(await s.core.yggdrasil.listTokens(s.uid)).toEqual([])
})

test('密码变更事件入队失败，改密码仍然成功，启动器令牌照样吊销', async () => {
  const token = await s.login()
  const browser = new Browser(s.core)
  expect((await browser.request('/api/auth/sign-in/email', { email, password })).status).toBe(200)
  s.core.events.subscribe('user.profileUpdated', 'test:password', { run: () => Promise.resolve() })
  const enqueue = s.core.jobs.enqueue.bind(s.core.jobs)
  const spy = vi.spyOn(s.core.jobs, 'enqueue').mockImplementation((tx, name, ...rest) => {
    if (name === 'test:password') return Promise.reject(new Error('queue unavailable'))
    return enqueue(tx, name, ...rest)
  })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const changed = await browser.request('/api/auth/change-password', {
      currentPassword: password,
      newPassword: 'new-password-for-launcher',
    })
    expect(changed.status).toBe(200)
    expect(warn).toHaveBeenCalledWith('[auth] password_event_failed')
  } finally {
    spy.mockRestore()
    warn.mockRestore()
  }
  await expect(validate(token.accessToken)).rejects.toMatchObject(failure('token_invalid'))
})

test('并发登录也不超过每用户上限', async () => {
  await s.setting('yggdrasil.tokensPerUser', 1)
  await Promise.all([s.login(), s.login(), s.login()])
  expect(await s.core.yggdrasil.listTokens(s.uid)).toHaveLength(1)
})

test('clientToken 超过 255 个字符或含 NUL 返回 400；用户名含 NUL 按找不到处理', async () => {
  await s.login({ clientToken: 'x'.repeat(255) })
  for (const clientToken of ['x'.repeat(256), 'a\0b'])
    await expect(s.login({ clientToken })).rejects.toMatchObject(
      failure('client_token_invalid', 'IllegalArgumentException'),
    )
  await expect(s.login({ username: 'Ste\0ve' })).rejects.toMatchObject(failure('invalid_credentials'))
})

function interceptedTokens(interceptIssueToken?: IssueTokenInterceptor) {
  return createTokens({ db: s.db(), settings: s.core.settings, secretKey, now: s.now, interceptIssueToken }).service
}
const loginInput = {
  username: email,
  password,
  rawPassword: password,
  clientToken: null,
  requestUser: false,
  ip: '192.0.2.45',
}

test('authenticate 插件拒绝不写令牌、不增加失败计数，via 和用户 scope 正确', async () => {
  const intercept = vi
    .fn<IssueTokenInterceptor>()
    .mockResolvedValue({ action: 'deny', plugin: 'a', reason: 'binding', message: '请先绑定' })
  const tokens = interceptedTokens(intercept)
  for (let n = 0; n < 6; n++)
    await expect(tokens.authenticate(loginInput)).rejects.toMatchObject({
      ...failure('plugin_denied'),
      locale: 'en',
      params: { message: '请先绑定' },
    })
  expect(await s.db().selectFrom('yggdrasil_tokens').select('id').execute()).toEqual([])
  expect(intercept).toHaveBeenLastCalledWith(
    { uid: s.uid, via: 'authenticate' },
    { actor: { kind: 'user', uid: s.uid, role: 'user' }, locale: 'en', ip: '192.0.2.45' },
  )
  intercept.mockResolvedValue({ action: 'allow' })
  expect((await tokens.authenticate(loginInput)).accessToken).toEqual(expect.any(String))
})

test('refresh 拒绝保留旧令牌，绑定后仍能刷新；unavailable 使用核心错误', async () => {
  const original = await s.login()
  const intercept = vi
    .fn<IssueTokenInterceptor>()
    .mockResolvedValue({ action: 'deny', plugin: 'a', reason: 'binding', message: '请先绑定' })
  const tokens = interceptedTokens(intercept)
  const input = {
    accessToken: original.accessToken,
    clientToken: original.clientToken,
    selectedProfile: null,
    requestUser: false,
    ip: null,
  }
  await expect(tokens.refresh(input)).rejects.toMatchObject(failure('plugin_denied'))
  await validate(original.accessToken)
  expect(await s.db().selectFrom('yggdrasil_tokens').select('id').execute()).toHaveLength(1)
  expect(intercept).toHaveBeenLastCalledWith(
    { uid: s.uid, via: 'refresh' },
    { actor: { kind: 'user', uid: s.uid, role: 'user' }, locale: 'en', ip: null },
  )
  intercept.mockResolvedValue({ action: 'unavailable' })
  await expect(tokens.refresh(input)).rejects.toMatchObject(failure('plugin_unavailable'))
  await expect(tokens.authenticate(loginInput)).rejects.toMatchObject(failure('plugin_unavailable'))
  intercept.mockResolvedValue({ action: 'allow' })
  await tokens.refresh(input)
  await expect(validate(original.accessToken)).rejects.toMatchObject(failure('token_invalid'))
})

test('密码、clientToken、封禁和新选角色检查不通过时不调用签发拦截器', async () => {
  const original = await s.login()
  const intercept = vi.fn<IssueTokenInterceptor>().mockResolvedValue({ action: 'allow' })
  const tokens = interceptedTokens(intercept)
  await expect(tokens.authenticate({ ...loginInput, password: 'wrong', rawPassword: 'wrong' })).rejects.toMatchObject(
    failure('invalid_credentials'),
  )
  await expect(tokens.authenticate({ ...loginInput, clientToken: '\0' })).rejects.toMatchObject(
    failure('client_token_invalid', 'IllegalArgumentException'),
  )
  await expect(
    tokens.refresh({
      accessToken: original.accessToken,
      clientToken: 'wrong',
      selectedProfile: null,
      requestUser: false,
    }),
  ).rejects.toMatchObject(failure('client_token_mismatch'))
  await expect(
    tokens.refresh({
      accessToken: original.accessToken,
      clientToken: null,
      selectedProfile: { name: 'Missing' },
      requestUser: false,
    }),
  ).rejects.toMatchObject(failure('player_not_found', 'IllegalArgumentException'))
  await s.db().updateTable('users').set({ role: 'banned' }).where('id', '=', s.uid).execute()
  await expect(tokens.authenticate(loginInput)).rejects.toMatchObject(failure('user_banned'))
  expect(intercept).not.toHaveBeenCalled()
})

test('核心接线补齐 requestId、默认语言和未知 IP；无拦截器不读默认语言', async () => {
  const seen = vi.fn()
  const core = s.makeCore({
    plugins: {
      official: [
        official(
          'a',
          definePlugin({
            capabilities: [],
            intercept: {
              'yggdrasil.issueToken': ({ scope }) => {
                seen(scope)
                return Promise.resolve(deny('binding', 'Bind first'))
              },
            },
          }),
        ),
      ],
    },
  })
  await core.plugins.start()
  await s.db().updateTable('users').set({ role: 'superadmin', locale: null }).where('id', '=', s.uid).execute()
  await s.setting('site.locale', 'zh-CN')
  await core.plugins.admin.enable({ uid: s.uid, ip: '192.0.2.1' }, 'a')
  await expect(s.login({}, core)).rejects.toMatchObject(failure('plugin_denied'))
  expect(seen).toHaveBeenLastCalledWith({
    requestId: expect.any(String) as string,
    actor: { kind: 'user', uid: s.uid, role: 'superadmin' },
    locale: 'zh-CN',
    ip: '',
  })
  await core.plugins.admin.disable({ uid: s.uid, ip: '192.0.2.1' }, 'a')
  const read = vi.spyOn(core.settings, 'read')
  await s.login({}, core)
  expect(read.mock.calls.some(([keys]) => keys.includes('site.locale'))).toBe(false)
  read.mockRestore()
  // 可选依赖缺省时沿用原来的签发流程。
  expect((await interceptedTokens().authenticate(loginInput)).accessToken).toEqual(expect.any(String))
})
