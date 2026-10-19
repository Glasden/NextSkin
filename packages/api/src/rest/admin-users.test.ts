import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser'
import { coreSettingsRegistry, DomainError, type Core, type CoreSettingKey } from '@nextskin/domain'
import { createTranslator, getMessages, locales, type Locale } from '@nextskin/i18n'
import { expect, test, vi, type Mock } from 'vitest'
import { createApp } from '../app.ts'
import { restErrorCode } from './errors.ts'

const methods = [
  'updateUser',
  'changeUserEmail',
  'setUserPassword',
  'disableUserTwoFactor',
  'deleteUserPasskeys',
  'unlinkUserAccount',
  'revokeUserSessions',
  'adjustUserScore',
  'deleteUser',
] as const
type Method = (typeof methods)[number]
const user = {
  uid: 7,
  nickname: 'Target',
  email: 'target@example.test',
  emailVerified: true,
  role: 'user',
  score: 1000,
  registeredAt: '2020-01-01T00:00:00.000Z',
  avatar: null,
}
const revoked = { revokedSessions: 2, revokedTokens: 1 }
/** 会话的 uid 和对端地址：用例只从这里拿操作者 */
const actor = { uid: 42, ip: '192.0.2.10' }
interface Endpoint {
  method: string
  path: string
  body?: unknown
  fn: Method
  /** 用例收到的参数，不含第一个参数 actor */
  args: unknown[]
  result: unknown
}
const endpoints: Endpoint[] = [
  {
    method: 'PATCH',
    path: '/admin/users/7',
    body: { nickname: 'New', emailVerified: true, expectedEmail: 'target@example.test' },
    fn: 'updateUser',
    args: [7, { nickname: 'New', emailVerified: true, expectedEmail: 'target@example.test' }],
    result: user,
  },
  {
    method: 'POST',
    path: '/admin/users/7/email',
    body: { email: 'new@example.test' },
    fn: 'changeUserEmail',
    args: [7, { email: 'new@example.test' }, 'http://example.test'],
    result: { status: 'pending', pendingEmail: 'new@example.test' },
  },
  {
    method: 'POST',
    path: '/admin/users/7/email',
    body: { email: 'new@example.test', verified: true },
    fn: 'changeUserEmail',
    args: [7, { email: 'new@example.test', verified: true }, 'http://example.test'],
    result: { status: 'changed', user: { ...user, email: 'new@example.test' } },
  },
  {
    method: 'POST',
    path: '/admin/users/7/password',
    body: { password: 'new-password-123', removeOtherMethods: true, newEmail: 'new@example.test' },
    fn: 'setUserPassword',
    args: [7, { password: 'new-password-123', removeOtherMethods: true, newEmail: 'new@example.test' }],
    result: revoked,
  },
  {
    method: 'DELETE',
    path: '/admin/users/7/two-factor',
    fn: 'disableUserTwoFactor',
    args: [7],
    result: user,
  },
  {
    method: 'DELETE',
    path: '/admin/users/7/passkeys',
    fn: 'deleteUserPasskeys',
    args: [7],
    result: { deleted: 3, ...revoked },
  },
  {
    method: 'DELETE',
    path: '/admin/users/7/bindings/oauth-github/github',
    fn: 'unlinkUserAccount',
    args: [7, 'oauth-github', 'github'],
    result: revoked,
  },
  {
    method: 'DELETE',
    path: '/admin/users/7/sessions',
    fn: 'revokeUserSessions',
    args: [7],
    result: { revokedSessions: 0, revokedTokens: 0 },
  },
  {
    method: 'POST',
    path: '/admin/users/7/score',
    body: { delta: -50, note: 'Refund' },
    fn: 'adjustUserScore',
    args: [7, { delta: -50, note: 'Refund' }],
    result: { score: 950 },
  },
  { method: 'DELETE', path: '/admin/users/7', fn: 'deleteUser', args: [7, { publicTextures: 'keep' }], result: {} },
  {
    method: 'DELETE',
    path: '/admin/users/7?publicTextures=delete',
    fn: 'deleteUser',
    args: [7, { publicTextures: 'delete' }],
    result: {},
  },
]

function setup() {
  const read = vi.fn((keys: readonly CoreSettingKey[]) =>
    Promise.resolve(Object.fromEntries(keys.map((key) => [key, coreSettingsRegistry[key].default]))),
  )
  const getSessionUser = vi.fn().mockResolvedValue({
    uid: actor.uid,
    sessionId: 1,
    nickname: 'Admin',
    email: 'admin@example.test',
    role: 'admin',
    locale: null,
  })
  const admin = Object.fromEntries(methods.map((name) => [name, vi.fn()])) as Record<Method, Mock>
  const changeEmail = vi.fn()
  const core = { settings: { read }, auth: { getSessionUser }, admin, users: { changeEmail } } as unknown as Core
  const app = createApp({ core })
  const request = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(
      `http://example.test/api${path}`,
      {
        method,
        headers: {
          origin: 'http://example.test',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      { peer: actor.ip },
    )
  return { app, request, admin, changeEmail, getSessionUser }
}
/** 文案按键查，参数照传：用来核对响应里用的是 admin.errors 还是 errors */
function translate(locale: Locale, key: string, params?: Record<string, string | number>): string {
  return (createTranslator(locale) as unknown as (key: string, params?: Record<string, string | number>) => string)(
    key,
    params,
  )
}

test.each(endpoints)('$method $path 返回用例的结果，操作者是会话 uid 和对端地址', async (endpoint) => {
  const { request, admin, getSessionUser } = setup()
  admin[endpoint.fn].mockResolvedValue(endpoint.result)
  const response = await request(endpoint.method, endpoint.path, endpoint.body)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(endpoint.result)
  expect(getSessionUser).toHaveBeenCalledWith(expect.any(Headers), 'http://example.test')
  expect(admin[endpoint.fn]).toHaveBeenCalledExactlyOnceWith(actor, ...endpoint.args)
})

test.each(endpoints)('$method $path 没有会话返回 401，不调用用例', async (endpoint) => {
  const { request, admin, getSessionUser } = setup()
  getSessionUser.mockResolvedValue(null)
  const response = await request(endpoint.method, endpoint.path, endpoint.body)
  expect(response.status).toBe(401)
  expect(await response.json()).toMatchObject({ error: { code: 'unauthenticated' } })
  for (const name of methods) expect(admin[name]).not.toHaveBeenCalled()
})

test.each(endpoints)('$method $path 的 uid 照现有接口校验', async (endpoint) => {
  const { request, admin } = setup()
  for (const value of ['0', '-1', '1.2', '1e2', '2147483648', '7x']) {
    const response = await request(endpoint.method, endpoint.path.replace('/users/7', `/users/${value}`), endpoint.body)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } })
  }
  expect(admin[endpoint.fn]).not.toHaveBeenCalled()
})

test.each([
  ['PATCH 空对象', 'PATCH', '/admin/users/7', {}],
  ['PATCH 只有 expectedEmail', 'PATCH', '/admin/users/7', { expectedEmail: 'target@example.test' }],
  ['PATCH 标记已验证却没有 expectedEmail', 'PATCH', '/admin/users/7', { emailVerified: true }],
  ['PATCH 不能任命超级管理员', 'PATCH', '/admin/users/7', { role: 'superadmin' }],
  ['PATCH 昵称不是字符串', 'PATCH', '/admin/users/7', { nickname: 1 }],
  ['PATCH 验证状态不是布尔值', 'PATCH', '/admin/users/7', { emailVerified: 'true', expectedEmail: 'a@example.test' }],
  ['改邮箱缺 email', 'POST', '/admin/users/7/email', {}],
  ['改邮箱的 verified 不是布尔值', 'POST', '/admin/users/7/email', { email: 'new@example.test', verified: 'yes' }],
  ['改密码缺 password', 'POST', '/admin/users/7/password', { removeOtherMethods: true }],
  [
    '改密码的 removeOtherMethods 不是布尔值',
    'POST',
    '/admin/users/7/password',
    { password: 'new-password-123', removeOtherMethods: 'true' },
  ],
  ['改密码的 newEmail 不是字符串', 'POST', '/admin/users/7/password', { password: 'new-password-123', newEmail: 1 }],
  ['delta 为 0', 'POST', '/admin/users/7/score', { delta: 0 }],
  ['delta 是小数', 'POST', '/admin/users/7/score', { delta: 1.5 }],
  ['delta 超过上界', 'POST', '/admin/users/7/score', { delta: 2147483648 }],
  ['delta 超过下界', 'POST', '/admin/users/7/score', { delta: -2147483648 }],
  ['delta 是字符串', 'POST', '/admin/users/7/score', { delta: '1' }],
  ['缺 delta', 'POST', '/admin/users/7/score', { note: 'Refund' }],
  ['note 超过 200 个字符', 'POST', '/admin/users/7/score', { delta: 1, note: 'a'.repeat(201) }],
  ['note 不是字符串', 'POST', '/admin/users/7/score', { delta: 1, note: 1 }],
  ['pluginId 超过 255 个字符', 'DELETE', `/admin/users/7/bindings/${'a'.repeat(256)}/github`, undefined],
  ['providerId 超过 255 个字符', 'DELETE', `/admin/users/7/bindings/github/${'a'.repeat(256)}`, undefined],
  ['publicTextures 取值不对', 'DELETE', '/admin/users/7?publicTextures=all', undefined],
] as const)('%s：400 invalid_request，不调用用例', async (_name, method, path, body) => {
  const { request, admin } = setup()
  const response = await request(method, path, body)
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } })
  for (const name of methods) expect(admin[name]).not.toHaveBeenCalled()
})

test('标记已验证缺 expectedEmail 时，字段错误挂在 expectedEmail 下', async () => {
  const response = await setup().request('PATCH', '/admin/users/7', { emailVerified: true })
  expect(await response.json()).toMatchObject({
    error: { code: 'invalid_request', fields: { expectedEmail: { code: 'invalid_value' } } },
  })
})

test.each([
  ['改回未验证不要求 expectedEmail', 'PATCH', '/admin/users/7', { emailVerified: false }, 'updateUser'],
  ['只改身份', 'PATCH', '/admin/users/7', { role: 'admin' }, 'updateUser'],
  ['delta 取上界', 'POST', '/admin/users/7/score', { delta: 2147483647 }, 'adjustUserScore'],
  ['delta 取下界', 'POST', '/admin/users/7/score', { delta: -2147483647 }, 'adjustUserScore'],
  // 字符按码点数，和用例一样先去掉首尾空白
  ['200 个表情的 note', 'POST', '/admin/users/7/score', { delta: 1, note: '😀'.repeat(200) }, 'adjustUserScore'],
  [
    '首尾空白不计入 note',
    'POST',
    '/admin/users/7/score',
    { delta: 1, note: ` ${'a'.repeat(200)} ` },
    'adjustUserScore',
  ],
  [
    '255 个字符的 Provider',
    'DELETE',
    `/admin/users/7/bindings/github/${'a'.repeat(255)}`,
    undefined,
    'unlinkUserAccount',
  ],
  ['显式留下公开材质', 'DELETE', '/admin/users/7?publicTextures=keep', undefined, 'deleteUser'],
] as const)('%s：交给用例', async (_name, method, path, body, fn) => {
  const { request, admin } = setup()
  admin[fn].mockResolvedValue(
    fn === 'updateUser' ? user : fn === 'adjustUserScore' ? { score: 1 } : fn === 'deleteUser' ? undefined : revoked,
  )
  const response = await request(method, path, body)
  expect(response.status).toBe(200)
  expect(admin[fn]).toHaveBeenCalledOnce()
})

const failures = [
  ['permission_denied', 403, 'updateUser', {}],
  ['user_not_manageable', 403, 'updateUser', {}],
  ['user_not_found', 404, 'updateUser', {}],
  ['nickname_invalid', 400, 'updateUser', { min: 1, max: 255 }],
  ['email_changed', 409, 'updateUser', {}],
  ['invalid_request', 400, 'updateUser', {}],
  ['email_invalid', 400, 'changeUserEmail', {}],
  ['email_unchanged', 400, 'changeUserEmail', {}],
  ['email_taken', 409, 'changeUserEmail', {}],
  ['user_banned', 403, 'changeUserEmail', {}],
  ['password_too_short', 400, 'setUserPassword', { min: 8 }],
  ['password_too_long', 400, 'setUserPassword', { max: 128 }],
  ['email_taken', 409, 'setUserPassword', {}],
  ['user_not_manageable', 403, 'disableUserTwoFactor', {}],
  ['last_login_method', 409, 'deleteUserPasskeys', {}],
  ['last_login_method', 409, 'unlinkUserAccount', {}],
  ['external_account_not_found', 404, 'unlinkUserAccount', {}],
  ['user_not_found', 404, 'revokeUserSessions', {}],
  ['score_out_of_range', 400, 'adjustUserScore', { balance: 10 }],
  ['permission_denied', 403, 'deleteUser', {}],
] as const
test.each(failures)('%s（%s）由 %s 抛出时映射状态码，按路径选文案', async (code, status, fn, params) => {
  const endpoint = endpoints.find((candidate) => candidate.fn === fn)!
  for (const locale of locales) {
    const { request, admin } = setup()
    admin[fn].mockRejectedValue(new DomainError(code, params))
    const response = await request(endpoint.method, endpoint.path, endpoint.body, { 'accept-language': locale })
    expect(response.status).toBe(status)
    const override: Record<string, string> = getMessages(locale).admin.errors
    expect(await response.json()).toMatchObject({
      error: {
        code,
        message: translate(locale, Object.hasOwn(override, code) ? `admin.errors.${code}` : `errors.${code}`, params),
      },
    })
  }
})

test('积分超出范围挂在 delta 下，参数带余额', async () => {
  const { request, admin } = setup()
  admin.adjustUserScore.mockRejectedValue(new DomainError('score_out_of_range', { balance: 10 }))
  const response = await request('POST', '/admin/users/7/score', { delta: -11 }, { 'accept-language': 'en' })
  expect(await response.json()).toMatchObject({
    error: {
      code: 'score_out_of_range',
      message: expect.stringContaining('10') as unknown,
      fields: { delta: { code: 'score_out_of_range' } },
    },
  })
})

test.each(locales)('admin.errors 只在 /api/admin/ 下覆盖（%s）', async (locale) => {
  const { request, admin, changeEmail } = setup()
  admin.changeUserEmail.mockRejectedValue(new DomainError('email_taken'))
  changeEmail.mockRejectedValue(new DomainError('email_taken'))
  const headers = { 'accept-language': locale }
  const forAdmin = await request('POST', '/admin/users/7/email', { email: 'taken@example.test' }, headers)
  const forSelf = await request(
    'POST',
    '/user/email',
    { email: 'taken@example.test', password: 'secret-password' },
    headers,
  )
  expect(forAdmin.status).toBe(409)
  expect(forSelf.status).toBe(409)
  const adminMessage = ((await forAdmin.json()) as { error: { message: string } }).error.message
  const selfMessage = ((await forSelf.json()) as { error: { message: string } }).error.message
  expect(adminMessage).toBe(translate(locale, 'admin.errors.email_taken'))
  expect(selfMessage).toBe(translate(locale, 'errors.email_taken'))
  expect(adminMessage).not.toBe(selfMessage)
  // 没有覆盖的错误码在后台照旧用 errors 的文案
  admin.setUserPassword.mockRejectedValue(new DomainError('password_too_short', { min: 8 }))
  const fallback = await request('POST', '/admin/users/7/password', { password: 'short' }, headers)
  expect(await fallback.json()).toMatchObject({
    error: { code: 'password_too_short', message: translate(locale, 'errors.password_too_short', { min: 8 }) },
  })
})

/** 消息里用到的参数名，包括 select、plural 分支里嵌套的（同 packages/i18n 的 messages.test.ts） */
function argumentsOf(elements: MessageFormatElement[], found = new Set<string>()): Set<string> {
  for (const element of elements) {
    if (element.type === TYPE.literal || element.type === TYPE.pound) continue
    found.add(element.value)
    if (element.type === TYPE.plural || element.type === TYPE.select) {
      for (const option of Object.values(element.options)) argumentsOf(option.value, found)
    }
    if (element.type === TYPE.tag) argumentsOf(element.children, found)
  }
  return found
}

test.each(locales)('admin.errors 的每个键都是 REST 的错误码，参数是 errors 里同名键参数的子集（%s）', (locale) => {
  const messages = getMessages(locale)
  const overrides: Record<string, string> = messages.admin.errors
  const general: Record<string, string> = messages.errors
  expect(Object.keys(overrides).length).toBeGreaterThan(0)
  for (const [code, message] of Object.entries(overrides)) {
    // 不是 REST 的错误码就会被当成 internal_error，这条覆盖永远用不上
    expect(restErrorCode(new DomainError(code)), code).toBe(code)
    expect(general[code], code).toBeDefined()
    const allowed = argumentsOf(parse(general[code]!))
    expect(
      [...argumentsOf(parse(message))].filter((name) => !allowed.has(name)),
      code,
    ).toEqual([])
  }
})
