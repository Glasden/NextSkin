import { toIsoTimestamp, upsert } from '@nextskin/db'
import { definePlugin, type PasswordHasherProvider } from '@nextskin/plugin-sdk'
import { hashPassword, verifyPassword } from 'better-auth/crypto'
import { afterEach, expect, test, vi } from 'vitest'
import { isCurrentPasswordHash } from '../auth/password.ts'
import { encodeSettingValue } from '../settings/codec.ts'
import { official, pluginEnvironment } from './plugins.test-helper.ts'

// passwordHasher（ADR-0033）：核心按 detect 认领、调用插件，网页登录和启动器登录核对通过后换成当前算法
const env = pluginEnvironment()
afterEach(() => vi.restoreAllMocks())

type Verify = (password: string, hash: string) => Promise<unknown>

function hasher(id: string, detect: PasswordHasherProvider<unknown>['detect'], verify: Verify) {
  return official(
    id,
    definePlugin({
      capabilities: [],
      providers: {
        passwordHasher: [
          { id: 'main', label: 'hasher', detect, verify: ({ password, hash }) => verify(password, hash) as never },
        ],
      },
    }),
  )
}

/** 测试用的"哈希"：`$test$` 后面直接是明文 */
const plain: Verify = (password, hash) => Promise.resolve(hash === `$test$${password}`)

async function enable(...ids: string[]) {
  const actor = await env.actor()
  for (const id of ids) await env.core.plugins.admin.enable(actor, id)
  return actor
}

async function userWithHash(hash: string) {
  const input = env.input()
  const { uid } = await env.core.users.register(input)
  await env.db.updateTable('accounts').set({ password: hash }).where('user_id', '=', uid).execute()
  return { uid, email: input.email }
}

async function storedHash(uid: number) {
  const row = await env.db
    .selectFrom('accounts')
    .select('password')
    .where('user_id', '=', uid)
    .where('provider_id', '=', 'credential')
    .executeTakeFirstOrThrow()
  return row.password!
}

function signIn(email: string, password: string) {
  const request = new Request('http://127.0.0.1:3000/api/auth/sign-in/email', {
    method: 'POST',
    headers: { origin: 'https://skin.example.test', 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  // Next 用 Proxy 包装 Request（auth.db.test.ts）
  const proxied = new Proxy(request, { get: (target, property) => Reflect.get(target, property, target) as unknown })
  return env.core.auth.handle(proxied, 'https://skin.example.test', '127.0.0.1')
}

test('按 detect 的前缀或正则匹配上才调用插件；没启用的插件、没人认领的哈希都不调用', async () => {
  const a = vi.fn(plain)
  const b = vi.fn(plain)
  const c = vi.fn(plain)
  await env.boot([
    hasher('a', { prefix: ['$a$'] }, a),
    hasher('b', { pattern: '^\\$b\\$[0-9]+$' }, b),
    hasher('c', { prefix: ['$a$'] }, c),
  ])
  await enable('a', 'b')
  expect(await env.core.plugins.verifyPassword({ hash: '$a$secret', password: 'secret' })).toBe(false)
  expect(a).toHaveBeenCalledWith('secret', '$a$secret')
  expect(await env.core.plugins.verifyPassword({ hash: '$b$123', password: 'secret' })).toBe(false)
  expect(b).toHaveBeenCalledTimes(1)
  expect(await env.core.plugins.verifyPassword({ hash: '$b$12x', password: 'secret' })).toBe(false)
  expect(await env.core.plugins.verifyPassword({ hash: '$z$secret', password: 'secret' })).toBe(false)
  expect(a).toHaveBeenCalledTimes(1)
  expect(b).toHaveBeenCalledTimes(1)
  expect(c).not.toHaveBeenCalled()
})

test('多个插件认领同一个哈希：按插件 id 依次调用，有一个通过就算通过', async () => {
  const order: string[] = []
  let first = false
  await env.boot([
    hasher('z-second', { prefix: ['$x$'] }, () => (order.push('z-second'), Promise.resolve(true))),
    hasher('a-first', { prefix: ['$x$'] }, () => (order.push('a-first'), Promise.resolve(first))),
  ])
  await enable('z-second', 'a-first')
  expect(await env.core.plugins.verifyPassword({ hash: '$x$', password: 'secret' })).toBe(true)
  expect(order).toEqual(['a-first', 'z-second'])
  order.length = 0
  first = true
  expect(await env.core.plugins.verifyPassword({ hash: '$x$', password: 'secret' })).toBe(true)
  expect(order).toEqual(['a-first'])
})

test('抛错、返回值不是布尔值都按不通过；日志里没有密码；连续失败三次熔断，冷却后恢复', async () => {
  let result: unknown = 'yes'
  const verify = vi.fn((password: string) =>
    result instanceof Error ? Promise.reject(new Error(`bad ${password}`)) : Promise.resolve(result),
  )
  await env.boot([hasher('a', { prefix: ['$a$'] }, verify)])
  await enable('a')
  const check = () => env.core.plugins.verifyPassword({ hash: '$a$hash', password: 'hunter2-secret' })
  expect(await check()).toBe(false)
  result = new Error()
  expect(await check()).toBe(false)
  expect(await check()).toBe(false)
  expect(verify).toHaveBeenCalledTimes(3)
  // 熔断中：不调用插件，直接不通过
  result = true
  expect(await check()).toBe(false)
  expect(verify).toHaveBeenCalledTimes(3)
  expect(env.records).toContainEqual(
    expect.objectContaining({ msg: 'password_verify_failed', provider: 'main', reason: 'error' }),
  )
  expect(env.records).toContainEqual(expect.objectContaining({ msg: 'breaker_open', key: 'a:passwordHasher:main' }))
  expect(JSON.stringify(env.records)).not.toContain('hunter2-secret')
  const now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now + 30_001)
  expect(await check()).toBe(true)
  expect(verify).toHaveBeenCalledTimes(4)
})

test('网页登录：插件核对通过后换成当前算法，首尾空白按 BS 的 trim 回退；停用插件后不再认领', async () => {
  await env.boot([hasher('a', { prefix: ['$test$'] }, plain)])
  const actor = await enable('a')
  const { uid, email } = await userWithHash('$test$secret')
  expect((await signIn(email, 'wrong')).status).toBe(401)
  expect(await storedHash(uid)).toBe('$test$secret')
  expect((await signIn(email, ' secret\t')).status).toBe(200)
  const rehashed = await storedHash(uid)
  expect(isCurrentPasswordHash(rehashed)).toBe(true)
  expect(await verifyPassword({ hash: rehashed, password: 'secret' })).toBe(true)
  expect((await signIn(email, 'secret')).status).toBe(200)
  expect((await signIn(email, ' secret\t')).status).toBe(401)

  const other = await userWithHash('$test$secret')
  await env.core.plugins.admin.disable(actor, 'a')
  expect((await signIn(other.email, 'secret')).status).toBe(401)
  expect(await storedHash(other.uid)).toBe('$test$secret')
})

test('网页登录换算法时只替换核对过的旧哈希：核对期间密码被重设了，不拿旧密码覆盖新密码', async () => {
  let calls = 0
  let uid = 0
  const reset = await hashPassword('new password')
  await env.boot([
    hasher('a', { prefix: ['$test$'] }, async (password, hash) => {
      // 第二次是登录之后换算法前的核对：这时用户正好重设了密码
      if (++calls === 2)
        await env.db.updateTable('accounts').set({ password: reset }).where('user_id', '=', uid).execute()
      return plain(password, hash)
    }),
  ])
  await enable('a')
  const user = await userWithHash('$test$secret')
  uid = user.uid
  expect((await signIn(user.email, 'secret')).status).toBe(200)
  expect(calls).toBe(2)
  expect(await storedHash(uid)).toBe(reset)
})

test('启动器登录：插件核对通过后换成当前算法，令牌照常签发', async () => {
  await env.boot([hasher('a', { prefix: ['$test$'] }, plain)])
  await enable('a')
  // 同一个账号连着登录两次，去掉登录间隔
  await upsert(env.db, 'settings', {
    values: {
      namespace: 'core',
      key: 'yggdrasil.loginIntervalMs',
      value: encodeSettingValue('yggdrasil.loginIntervalMs', 0, { secretKey: env.secretKey }),
      updated_at: toIsoTimestamp(new Date()),
    },
    conflict: ['namespace', 'key'],
    update: ['value', 'updated_at'],
  })
  const { uid, email } = await userWithHash('$test$secret')
  const login = (password: string) =>
    env.core.yggdrasil.authenticate({
      username: email,
      password,
      rawPassword: password,
      clientToken: null,
      requestUser: false,
    })
  await expect(login('wrong')).rejects.toMatchObject({ kind: 'ForbiddenOperationException' })
  expect(await storedHash(uid)).toBe('$test$secret')
  const response = await login('secret')
  expect(response.accessToken).toBeTruthy()
  expect(isCurrentPasswordHash(await storedHash(uid))).toBe(true)
})

test('敏感操作前核对密码：插件格式的哈希照样核对，不换算法', async () => {
  await env.boot([hasher('a', { prefix: ['$test$'] }, plain)])
  await enable('a')
  const { uid } = await userWithHash('$test$secret')
  await expect(env.core.users.deleteAccount({ uid }, { password: 'wrong' })).rejects.toMatchObject({
    code: 'password_incorrect',
  })
  expect(await storedHash(uid)).toBe('$test$secret')
  await env.core.users.deleteAccount({ uid }, { password: 'secret' })
  expect(await env.db.selectFrom('users').select('id').where('id', '=', uid).executeTakeFirst()).toBeUndefined()
})
