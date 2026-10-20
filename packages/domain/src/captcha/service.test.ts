import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createCaptcha } from './service.ts'
import type { createSettingQueries } from '../settings/queries.ts'
import { coreSettingsRegistry, type CoreSettingKey } from '../settings/registry.ts'

const providers = ['turnstile', 'hcaptcha', 'recaptcha'] as const
const endpoints = [
  'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  'https://api.hcaptcha.com/siteverify',
  'https://www.recaptcha.net/recaptcha/api/siteverify',
]
const input = { token: 'TOKEN_CANARY', ip: '198.51.100.7' }
afterEach(() => vi.restoreAllMocks())
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

function setup(provider: (typeof providers)[number] = 'turnstile') {
  const values: Partial<Record<CoreSettingKey, unknown>> = {
    'captcha.provider': provider,
    'captcha.siteKey': ' SITE_CANARY ',
    'captcha.secretKey': ' SECRET_CANARY ',
    'captcha.recaptchaInvisible': true,
    'site.url': 'https://skin.example.test:8443/path',
  }
  const settings = {
    read: vi.fn((keys: readonly CoreSettingKey[]) =>
      Promise.resolve(Object.fromEntries(keys.map((key) => [key, values[key] ?? coreSettingsRegistry[key].default]))),
    ),
  } as unknown as ReturnType<typeof createSettingQueries>
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ success: true, hostname: 'SKIN.example.test' }))
  const captcha = createCaptcha(settings, fetcher)
  return { values, fetcher, captcha }
}

test.each(providers)('%s 通过，表单编码、IP、超时和公开配置正确', async (provider) => {
  const { captcha, fetcher } = setup(provider)
  const timeout = vi.spyOn(AbortSignal, 'timeout')
  expect(await captcha.publicConfig()).toEqual({
    provider,
    siteKey: 'SITE_CANARY',
    invisible: provider === 'recaptcha',
  })
  await expect(captcha.verify(input)).resolves.toBeUndefined()
  expect(timeout).toHaveBeenCalledWith(10_000)
  expect(fetcher).toHaveBeenCalledTimes(1)
  const [url, options] = fetcher.mock.calls[0]!
  expect(url).toBe(endpoints[providers.indexOf(provider)])
  expect(options?.method).toBe('POST')
  expect(options?.headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded' })
  expect(options?.body).toBeInstanceOf(URLSearchParams)
  expect(options?.signal).toBeInstanceOf(AbortSignal)
  const body = fetcher.mock.calls[0]![1]!.body as URLSearchParams
  expect(Object.fromEntries(body)).toEqual({
    secret: 'SECRET_CANARY',
    response: input.token,
    remoteip: input.ip,
    ...(provider === 'hcaptcha' ? { sitekey: 'SITE_CANARY' } : {}),
  })
})

test.each(providers)('%s 不通过、主机名不符或缺失均拒绝；未设站点 URL 不查主机名', async (provider) => {
  const { captcha, values, fetcher } = setup(provider)
  for (const data of [
    { success: false, 'error-codes': ['invalid-input-response'] },
    { success: true, hostname: 'other.test' },
    { success: true },
  ]) {
    fetcher.mockResolvedValueOnce(Response.json(data))
    await expect(captcha.verify(input)).rejects.toMatchObject({ code: 'captcha_failed' })
  }
  values['site.url'] = ''
  fetcher.mockResolvedValueOnce(Response.json({ success: true }))
  expect(await captcha.test({ token: input.token, ip: null })).toEqual({ result: 'passed', errorCodes: [] })
  expect((fetcher.mock.calls.at(-1)![1]!.body as URLSearchParams).has('remoteip')).toBe(false)
})

test.each(providers)('%s 密钥错误记 error，服务商故障记 warn，令牌错误是 failed', async (provider) => {
  const { captcha, fetcher } = setup(provider)
  const configCodes = [
    'missing-input-secret',
    'invalid-input-secret',
    ...(provider === 'hcaptcha'
      ? [
          'sitekey-secret-mismatch',
          'invalid-sitekey',
          'missing-input-sitekey',
          'invalid-input-sitekey',
          'not-using-dummy-passcode',
        ]
      : []),
  ]
  for (const code of configCodes) {
    fetcher.mockResolvedValueOnce(Response.json({ success: false, 'error-codes': [code] }))
    expect(await captcha.test(input)).toEqual({ result: 'unavailable', errorCodes: [code] })
    expect(console.error).toHaveBeenLastCalledWith(`[captcha] ${provider} ${code}`)
  }
  for (const code of ['internal-error', 'bad-request']) {
    fetcher.mockResolvedValueOnce(Response.json({ success: false, 'error-codes': [code] }))
    await expect(captcha.verify(input)).rejects.toMatchObject({ code: 'captcha_unavailable' })
    expect(console.warn).toHaveBeenLastCalledWith(`[captcha] ${provider} provider_error`)
  }
  fetcher.mockResolvedValueOnce(Response.json({ success: false, 'error-codes': ['timeout-or-duplicate'] }))
  expect(await captcha.test(input)).toEqual({ result: 'failed', errorCodes: ['timeout-or-duplicate'] })
})

test.each(providers)('%s 超时、网络错误、非 2xx、非 JSON 和错误结构都不可用且日志不泄密', async (provider) => {
  const { captcha, fetcher } = setup(provider)
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort())
  fetcher.mockRejectedValueOnce(new DOMException('TOKEN_CANARY SECRET_CANARY', 'TimeoutError'))
  await expect(captcha.verify(input)).rejects.toMatchObject({ code: 'captcha_unavailable' })
  expect(console.warn).toHaveBeenLastCalledWith(`[captcha] ${provider} timeout`)
  timeout.mockRestore()
  fetcher.mockRejectedValueOnce(new Error('TOKEN_CANARY SECRET_CANARY'))
  await expect(captcha.verify(input)).rejects.toMatchObject({ code: 'captcha_unavailable' })
  for (const response of [
    new Response('SECRET_CANARY', { status: 503 }),
    new Response('TOKEN_CANARY'),
    ...[null, [], {}, { success: 'true' }, { success: true, 'error-codes': 'bad' }].map((value) =>
      Response.json(value),
    ),
  ]) {
    fetcher.mockResolvedValueOnce(response)
    expect(await captcha.test(input)).toEqual({ result: 'unavailable', errorCodes: [] })
  }
  expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toMatch(/TOKEN_CANARY|SECRET_CANARY|SITE_CANARY/)
})

test('没启用和两个密钥没填全时不发请求，每次都重新读设置', async () => {
  const { captcha, values, fetcher } = setup()
  for (const partial of [
    { 'captcha.provider': 'none', 'captcha.siteKey': 'site', 'captcha.secretKey': 'secret' },
    { 'captcha.provider': 'turnstile', 'captcha.siteKey': ' ', 'captcha.secretKey': 'secret' },
    { 'captcha.provider': 'turnstile', 'captcha.siteKey': 'site', 'captcha.secretKey': '\t' },
  ]) {
    Object.assign(values, partial)
    expect(await captcha.publicConfig()).toBeNull()
    await expect(captcha.verify({ token: null, ip: null })).resolves.toBeUndefined()
    await expect(captcha.test(input)).rejects.toMatchObject({ code: 'captcha_not_configured' })
  }
  expect(fetcher).not.toHaveBeenCalled()
  values['captcha.secretKey'] = 'secret'
  for (const token of [null, ''])
    await expect(captcha.verify({ token, ip: null })).rejects.toMatchObject({ code: 'captcha_required' })
  expect(fetcher).not.toHaveBeenCalled()
  values['captcha.recaptchaInvisible'] = false
  values['captcha.provider'] = 'recaptcha'
  expect(await captcha.publicConfig()).toEqual({ provider: 'recaptcha', siteKey: 'site', invisible: false })
})

test('诊断错误码最多十条，分类仍检查第十条之后的配置错误', async () => {
  const { captcha, fetcher } = setup()
  const codes = [...Array.from({ length: 12 }, (_, i) => `code-${i}`), 'invalid-input-secret']
  fetcher.mockResolvedValueOnce(Response.json({ success: false, 'error-codes': codes }))
  expect(await captcha.test(input)).toEqual({ result: 'unavailable', errorCodes: codes.slice(0, 10) })
  expect(console.error).toHaveBeenCalledWith('[captcha] turnstile invalid-input-secret')
})

test('错误码里有非字符串时当作响应格式不对，即使 success 为真也不放行', async () => {
  const { captcha, fetcher } = setup()
  fetcher.mockResolvedValueOnce(
    Response.json({ success: true, hostname: 'skin.example.test', 'error-codes': [null, 7, {}] }),
  )
  expect(await captcha.test(input)).toEqual({ result: 'unavailable', errorCodes: [] })
})
