import { expect, test } from 'vitest'
import { encodeSettingValue } from './codec.ts'
import { coreSettingsRegistry } from './registry.ts'

test('代理默认值兼容本机代理；IP/CIDR 的写入校验支持两种地址族', () => {
  const definition = coreSettingsRegistry['network.trustedProxies']
  expect(definition.schema.parse(definition.default)).toEqual(['127.0.0.0/8', '::1'])
  const valid = ['192.0.2.1', '192.0.2.0/24', '2001:db8::1', '2001:db8::/32', '::/0', '0.0.0.0/0']
  expect(JSON.parse(encodeSettingValue('network.trustedProxies', valid, { secretKey: 'x'.repeat(32) }))).toEqual(valid)
  for (const value of ['bad', '1.2.3.256', '192.0.2.0/33', '::/129', '::/-1', '::/', '::/1/2', '::/1.5'])
    expect(() => encodeSettingValue('network.trustedProxies', [value], { secretKey: 'x'.repeat(32) })).toThrow()
})

test('首页设置的长度和关键词数量有边界，默认值通过校验', () => {
  for (const key of ['site.description', 'site.keywords', 'site.footer'] as const) {
    const definition = coreSettingsRegistry[key]
    expect(definition.schema.safeParse(definition.default).success).toBe(true)
    expect(definition.section).toBe('site')
    expect(definition.secret).toBe(false)
  }
  const description = coreSettingsRegistry['site.description'].schema
  expect(description.safeParse('x'.repeat(200)).success).toBe(true)
  expect(description.safeParse('x'.repeat(201)).success).toBe(false)
  const footer = coreSettingsRegistry['site.footer'].schema
  expect(footer.safeParse('x'.repeat(2000)).success).toBe(true)
  expect(footer.safeParse('x'.repeat(2001)).success).toBe(false)
  const keywords = coreSettingsRegistry['site.keywords'].schema
  expect(keywords.safeParse(Array(32).fill('x'.repeat(64))).success).toBe(true)
  for (const value of [[''], ['x'.repeat(65)], Array(33).fill('x'), 'word'])
    expect(keywords.safeParse(value).success).toBe(false)
})

test('角色数量上限默认不限，只接受 0 到 1000 的整数', () => {
  const definition = coreSettingsRegistry['player.maxPerUser']
  expect(definition.default).toBe(0)
  expect(definition.section).toBe('content')
  expect(definition.secret).toBe(false)
  for (const value of [0, 1, 1000]) expect(definition.schema.safeParse(value).success).toBe(true)
  for (const value of [-1, 0.5, 1001, '1']) expect(definition.schema.safeParse(value).success).toBe(false)
})

test('维护默认关闭，说明最长 2000 字且使用 Markdown 控件', () => {
  for (const key of ['maintenance.enabled', 'maintenance.blockProtocols', 'maintenance.message'] as const) {
    const definition = coreSettingsRegistry[key]
    expect(definition.section).toBe('maintenance')
    expect(definition.secret).toBe(false)
    expect(definition.schema.safeParse(definition.default).success).toBe(true)
  }
  expect(coreSettingsRegistry['maintenance.enabled'].default).toBe(false)
  expect(coreSettingsRegistry['maintenance.blockProtocols'].default).toBe(false)
  expect(coreSettingsRegistry['maintenance.message'].default).toBe('')
  const message = coreSettingsRegistry['maintenance.message'].schema
  expect(message.safeParse('x'.repeat(2000)).success).toBe(true)
  expect(message.safeParse('x'.repeat(2001)).success).toBe(false)
  expect(message.meta()).toMatchObject({ contentMediaType: 'text/markdown' })
})
