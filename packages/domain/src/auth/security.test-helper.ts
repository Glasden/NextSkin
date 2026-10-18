import { createHmac } from 'node:crypto'
import type { Core } from '../core.ts'

export const ROOT = 'http://localhost:3000'
/** 请求级测试走真实 handler，Cookie 保存规则与浏览器相同。 */
export class Browser {
  readonly jar = new Map<string, string>()
  readonly core: Core
  readonly root: string
  constructor(core: Core, root = ROOT) {
    this.core = core
    this.root = root
  }
  cookieHeader() {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join('; ')
  }
  async request(path: string, json?: unknown, method = json === undefined ? 'GET' : 'POST') {
    const headers = new Headers({ origin: this.root, cookie: this.cookieHeader() })
    if (json !== undefined) headers.set('content-type', 'application/json')
    const response = await this.core.auth.handle(
      new Request(new URL(path, 'http://127.0.0.1:3000'), {
        method,
        headers,
        ...(json === undefined ? {} : { body: JSON.stringify(json) }),
      }),
      this.root,
      '127.0.0.1',
    )
    this.applyCookies(response.headers.getSetCookie())
    return response
  }
  applyCookies(cookies: string[]) {
    for (const cookie of cookies) {
      const pair = cookie.split(';')[0]!
      const index = pair.indexOf('=')
      const name = pair.slice(0, index),
        value = pair.slice(index + 1)
      if (!value || /max-age=0/i.test(cookie)) this.jar.delete(name)
      else this.jar.set(name, value)
    }
  }
  session() {
    return this.core.auth.getSessionUser(new Headers({ cookie: this.cookieHeader() }), this.root)
  }
}

/** RFC 6238：Base32 secret → 30 秒计数器 → HMAC-SHA1 的六位验证码。 */
export function totp(secret: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const bits = [...secret.toUpperCase().replace(/=+$/, '')]
    .map((c) => alphabet.indexOf(c).toString(2).padStart(5, '0'))
    .join('')
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)))
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)))
  const digest = createHmac('sha1', key).update(counter).digest()
  const offset = digest.at(-1)! & 15
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}
