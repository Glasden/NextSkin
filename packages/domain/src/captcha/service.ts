import { isIP } from 'node:net'
import { getLogger } from '@nextskin/logging'
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
  /** 服务商判定通过、主机名对不上时给后台测试看：站点地址的主机名和服务商报的那个 */
  hostname?: { expected: string; received: string | null }
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

/**
 * 服务商报的主机名对不对得上站点地址（ADR-0038"核对"）。hCaptcha 报的是注册域名（在 skin.example.com 上解出来的
 * 报 example.com），流量大时还会报 "not-provided"，它的文档也说这个字段来自浏览器、只作统计：只要求不是别的注册域名。
 * 比较前去掉末尾表示根域的点；顶级域名（去掉之后不带点）不算上级域名，站点地址是 IP 时不认上级
 */
function hostnameMatches(provider: CaptchaConfig['provider'], received: string | null, expected: string): boolean {
  const host = received?.toLowerCase()
  if (host === expected) return true
  if (provider !== 'hcaptcha' || !host) return false
  if (host === 'not-provided') return true
  const site = expected.replace(/\.$/, '')
  const parent = host.replace(/\.$/, '')
  if (isIP(site.replace(/^\[(.*)\]$/, '$1')) || !parent.includes('.')) return false
  return site === parent || site.endsWith(`.${parent}`)
}

/** 只返回核对结果；后台测试也走这一条路径，日志不含请求或完整响应。 */
export async function verifyCaptcha(
  config: CaptchaConfig,
  input: CaptchaInput,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<CaptchaResult> {
  const unavailable = (type: string, errorCodes: string[] = []): CaptchaResult => {
    getLogger('captcha').warn(type, { provider: config.provider })
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
    getLogger('captcha').error(configurationError, { provider: config.provider })
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
  if (data.success !== true) return { result: 'failed', errorCodes }
  if (!config.siteUrl) return { result: 'passed', errorCodes }
  const received = 'hostname' in data && typeof data.hostname === 'string' ? data.hostname : null
  const expected = new URL(config.siteUrl).hostname.toLowerCase()
  if (hostnameMatches(config.provider, received, expected)) return { result: 'passed', errorCodes }
  getLogger('captcha').warn('hostname_mismatch', { provider: config.provider, expected, received })
  return { result: 'failed', errorCodes, hostname: { expected, received } }
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
