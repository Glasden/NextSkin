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
