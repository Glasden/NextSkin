import { locales } from '@nextskin/i18n'
import { z } from 'zod'
import { generateSigningKey, parseSigningKey } from '../yggdrasil/signing-key.ts'
import { isTrustedProxy } from '../network/client-ip.ts'

export const coreSettingsNamespace = 'core'

export const settingSections = [
  'site',
  'registration',
  'captcha',
  'score',
  'content',
  'mail',
  'yggdrasil',
  'maintenance',
  'advanced',
] as const
export type SettingSection = (typeof settingSections)[number]

interface SettingDefinition {
  schema: z.ZodType
  default: unknown
  secret: boolean
  section: SettingSection | null
  check?: (value: never) => boolean
  generate?: () => Promise<unknown>
}

function validRegex(value: string): boolean {
  try {
    new RegExp(value, 'u')
    return true
  } catch {
    return false
  }
}

// 站点图片（ADR-0042）：值是存储里的像素 hash，null 时用内置的图形。图片控件按这个媒体类型生成（settings/form.ts）
const siteImage = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .nullable()
  .meta({ contentMediaType: 'image/png' })

export const coreSettingsRegistry = {
  'site.name': { schema: z.string(), default: 'NextSkin', section: 'site', secret: false },
  'site.logo': { schema: siteImage, default: null, section: 'site', secret: false },
  // 没设时用 site.logo，也没有时用默认图标
  'site.favicon': { schema: siteImage, default: null, section: 'site', secret: false },
  'site.description': { schema: z.string().max(200), default: '', section: 'site', secret: false },
  'site.keywords': {
    schema: z.array(z.string().min(1).max(64)).max(32),
    default: [],
    section: 'site',
    secret: false,
  },
  'site.url': {
    schema: z.union([z.literal(''), z.url({ protocol: /^https?$/ })]),
    default: '',
    section: 'site',
    secret: false,
  },
  // 站点默认语言：用户没有设置、浏览器也没有受支持的语言时用它（ADR-0019）
  'site.locale': { schema: z.enum(locales), default: 'zh-CN', section: 'site', secret: false },
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
    section: 'site',
    secret: false,
  },
  'site.announcement': {
    schema: z.string().max(20000).meta({ contentMediaType: 'text/markdown' }),
    default: '',
    section: 'site',
    secret: false,
  },
  'site.footer': {
    schema: z.string().max(2000).meta({ contentMediaType: 'text/markdown' }),
    default: '',
    section: 'site',
    secret: false,
  },
  'auth.registration.enabled': { schema: z.boolean(), default: true, section: 'registration', secret: false },
  'auth.registration.withPlayerName': { schema: z.boolean(), default: true, section: 'registration', secret: false },
  'auth.registration.perIpLimit': { schema: z.int().nonnegative(), default: 3, section: 'registration', secret: false },
  'auth.registration.emailDomains': {
    schema: z.object({ mode: z.enum(['any', 'allow', 'deny']), domains: z.array(z.string().trim().toLowerCase()) }),
    default: { mode: 'any', domains: [] },
    section: 'registration',
    secret: false,
  },
  'auth.requireEmailVerification': { schema: z.boolean(), default: false, section: 'registration', secret: false },
  'captcha.provider': {
    schema: z.enum(['none', 'turnstile', 'hcaptcha', 'recaptcha']),
    default: 'none',
    section: 'captcha',
    secret: false,
  },
  'captcha.siteKey': { schema: z.string(), default: '', section: 'captcha', secret: false },
  'captcha.secretKey': { schema: z.string(), default: '', section: 'captcha', secret: true },
  'captcha.recaptchaInvisible': { schema: z.boolean(), default: false, section: 'captcha', secret: false },
  'user.initialScore': { schema: z.int().min(0).max(2147483647), default: 1000, section: 'score', secret: false },
  'score.perPlayer': { schema: z.int().min(0).max(2147483647), default: 100, section: 'score', secret: false },
  'score.perKbPublic': { schema: z.int().min(0).max(2147483647), default: 1, section: 'score', secret: false },
  'score.perKbPrivate': { schema: z.int().min(0).max(2147483647), default: 10, section: 'score', secret: false },
  'score.perClosetItem': { schema: z.int().min(0).max(2147483647), default: 0, section: 'score', secret: false },
  'score.refundOnDelete': { schema: z.boolean(), default: true, section: 'score', secret: false },
  'checkIn.score': {
    schema: z
      .object({ min: z.int().min(0).max(2147483647), max: z.int().min(0).max(2147483647) })
      .refine(({ min, max }) => min <= max),
    default: { min: 10, max: 100 },
    section: 'score',
    secret: false,
  },
  'checkIn.gapHours': { schema: z.int().nonnegative(), default: 24, section: 'score', secret: false },
  'checkIn.resetAtMidnight': { schema: z.boolean(), default: false, section: 'score', secret: false },
  'report.cost': { schema: z.int().min(0).max(2147483647), default: 0, section: 'score', secret: false },
  'report.reward': { schema: z.int().min(0).max(2147483647), default: 0, section: 'score', secret: false },
  'player.nameRule': {
    schema: z.enum(['official', 'cjk', 'utf8', 'custom']),
    default: 'official',
    section: 'content',
    secret: false,
  },
  'player.nameRegex': { schema: z.string(), check: validRegex, default: '', section: 'content', secret: false },
  'player.nameLength': {
    // players.name 是 varchar(50)，users.nickname 是 varchar(255)。
    schema: z.object({ min: z.int().min(1), max: z.int().min(1).max(50) }).refine(({ min, max }) => min <= max),
    default: { min: 3, max: 16 },
    section: 'content',
    secret: false,
  },
  // BS 6.0.2 plugins/yggdrasil-api/callbacks.php：ygg_uuid_algorithm 默认 v3。
  'player.uuidAlgorithm': {
    schema: z.enum(['offline', 'random']),
    default: 'offline',
    section: 'content',
    secret: false,
  },
  'player.maxPerUser': { schema: z.int().min(0).max(1000), default: 0, section: 'content', secret: false },
  'texture.maxFileSizeKb': { schema: z.int().min(1).max(8192), default: 1024, section: 'content', secret: false },
  'texture.nameRegex': { schema: z.string(), check: validRegex, default: '', section: 'content', secret: false },
  'texture.contentPolicy': {
    schema: z.string().max(20000).meta({ contentMediaType: 'text/markdown' }),
    default: '',
    section: 'content',
    secret: false,
  },
  'mail.transport': { schema: z.enum(['none', 'smtp']), default: 'none', section: 'mail', secret: false },
  'mail.smtp': {
    schema: z.object({
      host: z.string(),
      port: z.int().min(1).max(65535),
      security: z.enum(['tls', 'starttls', 'none']),
      username: z.string(),
    }),
    default: { host: '', port: 587, security: 'starttls', username: '' },
    section: 'mail',
    secret: false,
  },
  'mail.smtp.password': { schema: z.string(), default: '', section: 'mail', secret: true },
  'mail.from': {
    schema: z.object({ address: z.union([z.literal(''), z.email()]), name: z.string() }),
    default: { address: '', name: '' },
    section: 'mail',
    secret: false,
  },
  // PEM 是否是可用的 RSA 密钥由 yggdrasil 模块判断；坏密钥也必须返回协议规定的 400。
  'yggdrasil.signingKey': {
    schema: z.string().nullable().meta({ contentMediaType: 'application/x-pem-file' }),
    check: (value: string | null) => value === null || parseSigningKey(value) !== null,
    generate: generateSigningKey,
    default: null,
    section: 'yggdrasil',
    secret: true,
  },
  'yggdrasil.skinDomains': { schema: z.array(z.string()), default: [], section: 'yggdrasil', secret: false },
  'yggdrasil.profileSearchLimit': {
    schema: z.number().int().positive(),
    default: 5,
    section: 'yggdrasil',
    secret: false,
  },
  'yggdrasil.apiLocationIndication': { schema: z.boolean(), default: true, section: 'yggdrasil', secret: false },
  'yggdrasil.tokenValidSeconds': {
    schema: z.int().min(1).max(31536000),
    default: 259200,
    section: 'yggdrasil',
    secret: false,
  },
  'yggdrasil.tokenRefreshableSeconds': {
    schema: z.int().min(1).max(31536000),
    default: 604800,
    section: 'yggdrasil',
    secret: false,
  },
  'yggdrasil.tokensPerUser': { schema: z.int().min(1).max(1000), default: 10, section: 'yggdrasil', secret: false },
  'yggdrasil.loginIntervalMs': {
    schema: z.int().min(0).max(600000),
    default: 1000,
    section: 'yggdrasil',
    secret: false,
  },
  'maintenance.enabled': { schema: z.boolean(), default: false, section: 'maintenance', secret: false },
  'maintenance.blockProtocols': { schema: z.boolean(), default: false, section: 'maintenance', secret: false },
  'maintenance.message': {
    schema: z.string().max(2000).meta({ contentMediaType: 'text/markdown' }),
    default: '',
    section: 'maintenance',
    secret: false,
  },
  // 默认信任回环地址，让同机的 nginx 等反向代理开箱可用（ADR-0018）。
  'network.trustedProxies': {
    schema: z.array(z.string().refine(isTrustedProxy, 'invalid IP or CIDR')),
    default: ['127.0.0.0/8', '::1'],
    section: 'advanced',
    secret: false,
  },
  'cache.publicMaxAge': {
    schema: z.number().int().nonnegative(),
    default: 31536000,
    section: 'advanced',
    secret: false,
  },
  // 0 表示永久保留审计日志（ADR-0029）。
  'audit.retentionDays': { schema: z.int().min(0).max(3650), default: 0, section: 'advanced', secret: false },
  // 旧站 .env 的 SALT：BS 的带盐摘要算法用它当全站 pepper，导入时写入（auth/legacy-passwords.ts）
  'auth.legacyPasswordSalt': { schema: z.string(), default: '', section: null, secret: true },
} as const satisfies Record<string, SettingDefinition>

export type CoreSettingKey = keyof typeof coreSettingsRegistry
export type CoreSettingValue<K extends CoreSettingKey> = z.infer<(typeof coreSettingsRegistry)[K]['schema']>
export type CoreSettings = { [K in CoreSettingKey]: CoreSettingValue<K> }
