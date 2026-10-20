import { DomainError } from '../errors.ts'
import type { createSettingQueries } from '../settings/queries.ts'

export const CAPTCHA_HEADER = 'x-captcha-response'

export interface CaptchaPublicConfig {
  provider: 'turnstile' | 'hcaptcha' | 'recaptcha'
  siteKey: string
  invisible: boolean
}

export interface CaptchaInput {
  token: string | null
  ip: string | null
}

export interface CaptchaResult {
  result: 'passed' | 'failed' | 'unavailable'
  errorCodes: string[]
}

interface CaptchaConfig extends CaptchaPublicConfig {
  secretKey: string
  siteUrl: string
}

const endpoints = {
  turnstile: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  hcaptcha: 'https://api.hcaptcha.com/siteverify',
  recaptcha: 'https://www.recaptcha.net/recaptcha/api/siteverify',
}

// 各家的 siteverify 错误码表：密钥错误属于站点配置问题，不算用户没过（ADR-0038）。
const configurationErrors = {
  turnstile: ['missing-input-secret', 'invalid-input-secret'],
  hcaptcha: [
    'missing-input-secret',
    'invalid-input-secret',
    'sitekey-secret-mismatch',
    'missing-input-sitekey',
    'invalid-input-sitekey',
    'invalid-sitekey',
    'not-using-dummy-passcode',
  ],
  recaptcha: ['missing-input-secret', 'invalid-input-secret'],
}

/** 只返回核对结果；后台测试也走这一条路径，日志不含请求或完整响应。 */
export async function verifyCaptcha(
  config: CaptchaConfig,
  input: CaptchaInput,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<CaptchaResult> {
  const unavailable = (type: string, errorCodes: string[] = []): CaptchaResult => {
    console.warn(`[captcha] ${config.provider} ${type}`)
    return { result: 'unavailable', errorCodes }
  }
  const body = new URLSearchParams({ secret: config.secretKey, response: input.token ?? '' })
  if (input.ip) body.set('remoteip', input.ip)
  if (config.provider === 'hcaptcha') body.set('sitekey', config.siteKey)
  const signal = AbortSignal.timeout(10_000)
  let response: Response
  try {
    response = await fetcher(endpoints[config.provider], {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal,
    })
  } catch {
    return unavailable(signal.aborted ? 'timeout' : 'network_error')
  }
  if (!response.ok) return unavailable('http_error')
  let data: unknown
  try {
    data = await response.json()
  } catch {
    return unavailable(signal.aborted ? 'timeout' : 'invalid_json')
  }
  if (typeof data !== 'object' || data === null) return unavailable('invalid_response')
  const codes: unknown[] = 'error-codes' in data && Array.isArray(data['error-codes']) ? data['error-codes'] : []
  const errorCodes = codes.filter((code): code is string => typeof code === 'string').slice(0, 10)
  if (
    !('success' in data) ||
    typeof data.success !== 'boolean' ||
    ('error-codes' in data && !Array.isArray(data['error-codes'])) ||
    codes.length !== codes.filter((code) => typeof code === 'string').length
  )
    return unavailable('invalid_response', errorCodes)
  // 分类检查全部错误码，返回给后台的诊断信息最多十条。
  const configurationError = configurationErrors[config.provider].find((code) => codes.includes(code))
  if (configurationError) {
    console.error(`[captcha] ${config.provider} ${configurationError}`)
    return { result: 'unavailable', errorCodes }
  }
  if (
    codes.some(
      (code) =>
        typeof code === 'string' &&
        ['internal-error', 'bad-request', 'missing-remoteip', 'invalid-remoteip'].includes(code),
    )
  )
    return unavailable('provider_error', errorCodes)
  const hostname = 'hostname' in data && typeof data.hostname === 'string' ? data.hostname : null
  const passed =
    data.success === true &&
    (!config.siteUrl || hostname?.toLowerCase() === new URL(config.siteUrl).hostname.toLowerCase())
  return { result: passed ? 'passed' : 'failed', errorCodes }
}

export function createCaptcha(settings: ReturnType<typeof createSettingQueries>, fetcher?: typeof fetch) {
  async function config(): Promise<CaptchaConfig | null> {
    const values = await settings.read([
      'captcha.provider',
      'captcha.siteKey',
      'captcha.secretKey',
      'captcha.recaptchaInvisible',
      'site.url',
    ])
    const provider = values['captcha.provider']
    const siteKey = values['captcha.siteKey'].trim()
    const secretKey = values['captcha.secretKey'].trim()
    if (provider === 'none' || !siteKey || !secretKey) return null
    return {
      provider,
      siteKey,
      secretKey,
      invisible: provider === 'recaptcha' && values['captcha.recaptchaInvisible'],
      siteUrl: values['site.url'],
    }
  }

  async function check(input: CaptchaInput, requireConfigured: boolean): Promise<CaptchaResult> {
    const current = await config()
    if (!current) {
      if (requireConfigured) throw new DomainError('captcha_not_configured')
      return { result: 'passed', errorCodes: [] }
    }
    if (!input.token) throw new DomainError('captcha_required')
    return verifyCaptcha(current, input, fetcher)
  }

  return {
    async publicConfig(): Promise<CaptchaPublicConfig | null> {
      const current = await config()
      return current ? { provider: current.provider, siteKey: current.siteKey, invisible: current.invisible } : null
    },
    async verify(input: CaptchaInput): Promise<void> {
      const { result } = await check(input, false)
      if (result === 'failed') throw new DomainError('captcha_failed')
      if (result === 'unavailable') throw new DomainError('captcha_unavailable')
    },
    test: (input: CaptchaInput) => check(input, true),
  }
}

export type CaptchaService = ReturnType<typeof createCaptcha>
