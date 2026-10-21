import { settingControl as pluginSettingControl, type SettingControl as PluginControl } from '@nextskin/plugin-host'
import { expect, test } from 'vitest'
import { settingControl, settingJsonSchema, type SettingControl, type JsonSchema } from './form.ts'
import { coreSettingsRegistry, settingSections, type CoreSettingKey } from './registry.ts'

const text: PluginControl = { kind: 'text', format: null, required: false, maxLength: null }
const boolean: PluginControl = { kind: 'boolean' }
const lines: PluginControl = { kind: 'lines' }
const integer = (min: number | null, max: number | null = null): PluginControl => ({
  kind: 'number',
  integer: true,
  min,
  max,
})
const select = (...options: string[]): PluginControl => ({ kind: 'select', options })
const object = (properties: Record<string, PluginControl>): PluginControl => ({
  kind: 'object',
  properties: Object.entries(properties).map(([name, control]) => ({ name, control })),
})
const score = integer(0, 2147483647)
const markdown: PluginControl = { kind: 'markdown', maxLength: 20000 }
const image: SettingControl = { kind: 'image', minSide: 16, maxSide: 512 }
const expected = {
  'site.name': text,
  'site.logo': image,
  'site.favicon': image,
  'site.description': { ...text, maxLength: 200 },
  'site.keywords': lines,
  'site.url': { ...text, format: 'url' },
  'site.locale': select('zh-CN', 'en'),
  'site.timeZone': text,
  'site.announcement': markdown,
  'site.footer': { kind: 'markdown', maxLength: 2000 },
  'auth.registration.enabled': boolean,
  'auth.registration.withPlayerName': boolean,
  'auth.registration.perIpLimit': integer(0),
  'auth.registration.emailDomains': object({ mode: select('any', 'allow', 'deny'), domains: lines }),
  'auth.requireEmailVerification': boolean,
  'captcha.provider': select('none', 'turnstile', 'hcaptcha', 'recaptcha'),
  'captcha.siteKey': text,
  'captcha.secretKey': { kind: 'secret', multiline: false },
  'captcha.recaptchaInvisible': boolean,
  'user.initialScore': score,
  'score.perPlayer': score,
  'score.perKbPublic': score,
  'score.perKbPrivate': score,
  'score.perClosetItem': score,
  'score.refundOnDelete': boolean,
  'checkIn.score': object({ min: score, max: score }),
  'checkIn.gapHours': integer(0),
  'checkIn.resetAtMidnight': boolean,
  'report.cost': score,
  'report.reward': score,
  'player.nameRule': select('official', 'cjk', 'utf8', 'custom'),
  'player.nameRegex': text,
  'player.nameLength': object({ min: integer(1), max: integer(1, 50) }),
  'player.uuidAlgorithm': select('offline', 'random'),
  'texture.maxFileSizeKb': integer(1, 8192),
  'texture.nameRegex': text,
  'texture.contentPolicy': markdown,
  'mail.transport': select('none', 'smtp'),
  'mail.smtp': object({
    host: text,
    port: integer(1, 65535),
    security: select('tls', 'starttls', 'none'),
    username: text,
  }),
  'mail.smtp.password': { kind: 'secret', multiline: false },
  'mail.from': object({ address: { ...text, format: 'email' }, name: text }),
  'yggdrasil.signingKey': { kind: 'secret', multiline: true },
  'yggdrasil.skinDomains': lines,
  'yggdrasil.profileSearchLimit': integer(null),
  'yggdrasil.apiLocationIndication': boolean,
  'yggdrasil.tokenValidSeconds': integer(1, 31536000),
  'yggdrasil.tokenRefreshableSeconds': integer(1, 31536000),
  'yggdrasil.tokensPerUser': integer(1, 1000),
  'yggdrasil.loginIntervalMs': integer(0, 600000),
  'network.trustedProxies': lines,
  'cache.publicMaxAge': integer(0),
  'audit.retentionDays': integer(0, 3650),
} satisfies Partial<Record<CoreSettingKey, SettingControl>>

test('每个可见设置都有预期控件，注册表按分区和页面顺序排列', () => {
  const visible = (Object.keys(coreSettingsRegistry) as CoreSettingKey[]).filter(
    (key) => coreSettingsRegistry[key].section !== null,
  )
  expect(visible).toEqual(Object.keys(expected))
  expect([...new Set(visible.map((key) => coreSettingsRegistry[key].section))]).toEqual(settingSections)
  for (const [key, control] of Object.entries(expected)) {
    expect(settingControl(settingJsonSchema(key as CoreSettingKey)), key).toEqual(control)
  }
  expect(Object.keys(coreSettingsRegistry).at(-1)).toBe('auth.legacyPasswordSalt')
})

test.each<[JsonSchema, SettingControl]>([
  [
    { type: 'number', minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
    { kind: 'number', integer: false, min: null, max: null },
  ],
  [
    { type: 'number', minimum: -2, maximum: 3.5 },
    { kind: 'number', integer: false, min: -2, max: 3.5 },
  ],
  [
    { type: 'string', minLength: 1, maxLength: 20, format: 'email' },
    { ...text, required: true, maxLength: 20, format: 'email' },
  ],
  [{ type: 'string', format: 'date' }, text],
  [
    { type: 'string', contentMediaType: 'text/markdown' },
    { kind: 'markdown', maxLength: null },
  ],
  [
    { writeOnly: true, anyOf: [{ type: 'null' }, { type: 'string' }], contentMediaType: 'application/x-pem-file' },
    { kind: 'secret', multiline: true },
  ],
  [{ anyOf: [{ type: 'string' }, { type: 'null' }], contentMediaType: 'image/png' }, image],
])('映射独立 JSON Schema：%j', (schema, control) => {
  expect(settingControl(schema)).toEqual(control)
})

test.each<JsonSchema>([
  {},
  { type: 'null' },
  { type: 'array', items: { type: 'number' } },
  { enum: [1, 2] },
  { anyOf: [{ type: 'number' }, { type: 'string' }] },
  { type: 'object', properties: { nested: { type: 'object', properties: {} } } },
  { type: 'object', properties: { password: { type: 'string', writeOnly: true } } },
  { type: 'object', properties: { unknown: { type: 'null' } } },
  { type: 'number', writeOnly: true },
])('映射不了的类型返回 null：%j', (schema) => {
  expect(settingControl(schema)).toBeNull()
})

// 站点图片只给核心的设置项（ADR-0042）：插件的设置走 plugin-host 的规则，带同样的媒体类型也没有控件
test('插件的设置没有图片控件', () => {
  const schema: JsonSchema = { anyOf: [{ type: 'string' }, { type: 'null' }], contentMediaType: 'image/png' }
  expect(pluginSettingControl(schema)).toBeNull()
  expect(settingControl({ type: 'string', contentMediaType: 'image/png' })).toEqual(text)
})
