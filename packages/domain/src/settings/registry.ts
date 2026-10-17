import { locales } from '@nextskin/i18n'
import { z } from 'zod'
import { isTrustedProxy } from '../network/client-ip.ts'

export const coreSettingsNamespace = 'core'

export const coreSettingsRegistry = {
  // 默认信任回环地址，让同机的 nginx 等反向代理开箱可用（ADR-0018）。
  'network.trustedProxies': {
    schema: z.array(z.string().refine(isTrustedProxy, 'invalid IP or CIDR')),
    default: ['127.0.0.0/8', '::1'],
    secret: false,
  },
  'site.url': { schema: z.union([z.literal(''), z.url({ protocol: /^https?$/ })]), default: '', secret: false },
  'site.name': { schema: z.string(), default: 'NextSkin', secret: false },
  // 站点默认语言：用户没有设置、浏览器也没有受支持的语言时用它（ADR-0019）
  'site.locale': { schema: z.enum(locales), default: 'zh-CN', secret: false },
  // 日期和时间按这个时区显示，服务端渲染和浏览器一致（ADR-0019）；默认与 BS 相同
  'site.timeZone': {
    schema: z.string().refine((zone) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: zone })
        return true
      } catch {
        return false
      }
    }, 'unknown time zone'),
    default: 'Asia/Shanghai',
    secret: false,
  },
  'cache.publicMaxAge': { schema: z.number().int().nonnegative(), default: 31536000, secret: false },
  'yggdrasil.skinDomains': { schema: z.array(z.string()), default: [], secret: false },
  'yggdrasil.profileSearchLimit': { schema: z.number().int().positive(), default: 5, secret: false },
  'yggdrasil.apiLocationIndication': { schema: z.boolean(), default: true, secret: false },
  // PEM 是否是可用的 RSA 密钥由 yggdrasil 模块判断；坏密钥也必须返回协议规定的 400。
  'yggdrasil.signingKey': { schema: z.string().nullable(), default: null, secret: true },
  // 旧站 .env 的 SALT：BS 的带盐摘要算法用它当全站 pepper，导入时写入（auth/legacy-passwords.ts）
  'auth.legacyPasswordSalt': { schema: z.string(), default: '', secret: true },
  'auth.registration.enabled': { schema: z.boolean(), default: true, secret: false },
  'auth.registration.withPlayerName': { schema: z.boolean(), default: true, secret: false },
  'auth.registration.perIpLimit': { schema: z.int().nonnegative(), default: 3, secret: false },
  'auth.registration.emailDomains': {
    schema: z.object({ mode: z.enum(['any', 'allow', 'deny']), domains: z.array(z.string().trim().toLowerCase()) }),
    default: { mode: 'any', domains: [] },
    secret: false,
  },
  'auth.requireEmailVerification': { schema: z.boolean(), default: false, secret: false },
  'score.perPlayer': { schema: z.int().min(0).max(2147483647), default: 100, secret: false },
  'score.refundOnDelete': { schema: z.boolean(), default: true, secret: false },
  'checkIn.score': {
    schema: z
      .object({ min: z.int().min(0).max(2147483647), max: z.int().min(0).max(2147483647) })
      .refine(({ min, max }) => min <= max),
    default: { min: 10, max: 100 },
    secret: false,
  },
  'checkIn.gapHours': { schema: z.int().nonnegative(), default: 24, secret: false },
  'checkIn.resetAtMidnight': { schema: z.boolean(), default: false, secret: false },
  'user.initialScore': { schema: z.int().min(0).max(2147483647), default: 1000, secret: false },
  'player.nameRule': { schema: z.enum(['official', 'cjk', 'utf8', 'custom']), default: 'official', secret: false },
  'player.nameRegex': { schema: z.string(), default: '', secret: false },
  'player.nameLength': {
    // players.name 是 varchar(50)，users.nickname 是 varchar(255)。
    schema: z.object({ min: z.int().min(1), max: z.int().min(1).max(50) }).refine(({ min, max }) => min <= max),
    default: { min: 3, max: 16 },
    secret: false,
  },
  // BS 6.0.2 plugins/yggdrasil-api/callbacks.php：ygg_uuid_algorithm 默认 v3。
  'player.uuidAlgorithm': { schema: z.enum(['offline', 'random']), default: 'offline', secret: false },
  'mail.transport': { schema: z.enum(['none', 'smtp']), default: 'none', secret: false },
  'mail.smtp': {
    schema: z.object({
      host: z.string(),
      port: z.int().min(1).max(65535),
      security: z.enum(['tls', 'starttls', 'none']),
      username: z.string(),
    }),
    default: { host: '', port: 587, security: 'starttls', username: '' },
    secret: false,
  },
  'mail.smtp.password': { schema: z.string(), default: '', secret: true },
  'mail.from': {
    schema: z.object({ address: z.union([z.literal(''), z.email()]), name: z.string() }),
    default: { address: '', name: '' },
    secret: false,
  },
} as const

export type CoreSettingKey = keyof typeof coreSettingsRegistry
export type CoreSettingValue<K extends CoreSettingKey> = z.infer<(typeof coreSettingsRegistry)[K]['schema']>
export type CoreSettings = { [K in CoreSettingKey]: CoreSettingValue<K> }
