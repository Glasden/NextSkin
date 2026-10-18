import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

export const EMAIL_CHANGE_TTL_SECONDS = 3600
const payloadSchema = z
  .object({
    uid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    emailVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    oldEmail: z.email().max(255),
    newEmail: z.email().max(255),
    expiresAt: z.number().int().positive(),
  })
  .strict()
type Payload = z.infer<typeof payloadSchema>

/** 令牌不落库：条件 UPDATE 检查并递增邮箱版本，改回旧地址也不会复活旧链接。 */
export function createEmailChangeTokens(secretKey: string) {
  const key = Buffer.from(hkdfSync('sha256', secretKey, 'NextSkin email change v1', 'email change HMAC-SHA256', 32))
  const mac = (payload: string) => createHmac('sha256', key).update(payload).digest()
  return {
    sign(payload: Payload): string {
      const encoded = Buffer.from(JSON.stringify(payloadSchema.parse(payload))).toString('base64url')
      return `${encoded}.${mac(encoded).toString('base64url')}`
    },
    parse(token: string): Payload | null {
      try {
        if (token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null
        const [encoded, signature] = token.split('.') as [string, string]
        const actual = Buffer.from(signature, 'base64url')
        const expected = mac(encoded)
        if (
          actual.toString('base64url') !== signature ||
          actual.length !== expected.length ||
          !timingSafeEqual(actual, expected)
        )
          return null
        const payload = payloadSchema.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')))
        return payload.expiresAt > Date.now() ? payload : null
      } catch {
        return null
      }
    },
  }
}
