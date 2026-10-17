import { z } from 'zod'

export const coreSettingsNamespace = 'core'

export const coreSettingsRegistry = {
  'site.url': { schema: z.union([z.literal(''), z.url({ protocol: /^https?$/ })]), default: '', secret: false },
  'site.name': { schema: z.string(), default: 'NextSkin', secret: false },
  'cache.publicMaxAge': { schema: z.number().int().nonnegative(), default: 31536000, secret: false },
  'yggdrasil.skinDomains': { schema: z.array(z.string()), default: [], secret: false },
  'yggdrasil.profileSearchLimit': { schema: z.number().int().positive(), default: 5, secret: false },
  'yggdrasil.apiLocationIndication': { schema: z.boolean(), default: true, secret: false },
  // PEM 是否是可用的 RSA 密钥由 yggdrasil 模块判断；坏密钥也必须返回协议规定的 400。
  'yggdrasil.signingKey': { schema: z.string().nullable(), default: null, secret: true },
  // 旧站 .env 的 SALT：BS 的带盐摘要算法用它当全站 pepper，导入时写入（auth/legacy-passwords.ts）
  'auth.legacyPasswordSalt': { schema: z.string(), default: '', secret: true },
} as const

export type CoreSettingKey = keyof typeof coreSettingsRegistry
export type CoreSettingValue<K extends CoreSettingKey> = z.infer<(typeof coreSettingsRegistry)[K]['schema']>
export type CoreSettings = { [K in CoreSettingKey]: CoreSettingValue<K> }
