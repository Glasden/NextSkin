import { expect, test } from 'vitest'
import { createDiagnosticsRedactor } from './redact.ts'
const make = () =>
  createDiagnosticsRedactor({
    instanceDirectory: '/home/owner/nextskin',
    dataDirectory: '/mnt/data',
    homeDirectory: '/home/owner',
  })

test('常见机密先兜底，邮箱大小写共享编号、跨字段一致，原始标识符保留', () => {
  const redact = make()
  expect(redact.text('User@example.com user@EXAMPLE.com Other@example.com')).toBe('<邮箱1> <邮箱1> <邮箱2>')
  expect(redact.value({ smtp: 'USER@example.com', token: 'Bearer abcdefghijklmnopqrstuvwxyz' })).toEqual({
    smtp: '<邮箱1>',
    token: 'Bearer [redacted]',
  })
  for (const secret of [
    'password=supersecret',
    'https://user:pass@host/path?token=supersecret',
    'Authorization: Bearer supersecret123456',
  ]) {
    const result = redact.text(secret)
    expect(result).not.toContain('supersecret')
    expect(result).not.toContain('user:pass')
  }
  const identifiers = 'Steve uid=42 16.4.2 12:30:45 550e8400-e29b-41d4-a716-446655440000 ' + 'a'.repeat(64)
  expect(redact.text(identifiers)).toBe(identifiers)
})
test('公网 v4/v6；IPv6 的等价写法共享编号，四段有效范围和边界受校验', () => {
  const redact = make()
  expect(redact.text('8.8.8.8 8.8.8.8 [2001:4860:4860::8888] 2001:4860:4860:0:0:0:0:8888')).toBe(
    '<IP1> <IP1> [<IP2>] <IP2>',
  )
  expect(redact.text('::ffff:8.8.4.4')).toBe('<IP3>')
  const invalid = '256.1.2.3 1.2.3.456 1.2.3.4.5 01.2.3.4 version=16.4.2 12:30:45 abcd:ghij::1234'
  expect(redact.text(invalid)).toBe(invalid)
})
test('私网、回环、链路本地、零地址及 IPv4 映射中的私网保留，边界外替换', () => {
  const redact = make()
  const kept =
    '10.0.0.1 172.16.0.1 172.31.255.255 192.168.1.1 127.3.2.1 169.254.2.3 0.0.0.0 :: ::1 fc00::1 fdff::1 fe80::1 febf::1 ::ffff:192.168.1.1 ::ffff:c0a8:101'
  expect(redact.text(kept)).toBe(kept)
  expect(redact.text('172.15.0.1 172.32.0.1 192.169.1.1 fec0::1')).toBe('<IP1> <IP2> <IP3> <IP4>')
})
test('路径先长后短、按目录边界匹配；Windows 反斜杠与大小写，外部数据目录', () => {
  const redact = make()
  expect(redact.text('/home/owner/nextskin/log /home/owner/doc /mnt/data/log /home/owner/nextskin-other')).toBe(
    '<实例目录>/log ~/doc <数据目录>/log ~/nextskin-other',
  )
  const windows = createDiagnosticsRedactor({
    instanceDirectory: 'C:\\Users\\Alice\\NextSkin',
    dataDirectory: 'C:\\Users\\Alice\\NextSkin\\data',
    homeDirectory: 'C:\\Users\\Alice',
  })
  expect(windows.text('c:\\users\\ALICE\\nextskin\\data C:/Users/Alice/doc C:\\Users\\AliceOther')).toBe(
    '<实例目录>\\data ~/doc C:\\Users\\AliceOther',
  )
  expect(redact.value({ nested: ['/mnt/data/x', 'user@example.com'], uid: 7 })).toEqual({
    nested: ['<数据目录>/x', '<邮箱1>'],
    uid: 7,
  })
})

test('IPv6 句末标点和 JSON 中转义的 Windows 路径', () => {
  expect(make().text('address=2001:db8::1.')).toBe('address=<IP1>.')
  const windows = createDiagnosticsRedactor({
    instanceDirectory: 'C:\\Users\\Alice\\NextSkin',
    dataDirectory: 'D:\\data',
    homeDirectory: 'C:\\Users\\Alice',
  })
  const input = JSON.stringify({ path: 'C:\\Users\\Alice\\NextSkin\\logs', password: 'private-secret' })
  expect(JSON.parse(windows.text(input))).toEqual({ path: '<实例目录>\\logs', password: '[redacted]' })
})

test('很长的无效 IPv6 候选不会触发嵌套重复的正则回溯', () => {
  const input = 'a:'.repeat(20_000) + 'z'
  expect(make().text(input)).toBe(input)
})

test('带端口的公网 v4 照样替换，内网的和时间保留', () => {
  expect(make().text('peer=203.0.113.5:3000 http://198.51.100.7:8080/x 127.0.0.1:3000 at 12:30:45.123')).toBe(
    'peer=<IP1>:3000 http://<IP2>:8080/x 127.0.0.1:3000 at 12:30:45.123',
  )
})

test('包版本和 scoped 包名不是邮箱', () => {
  const stack = 'at /srv/node_modules/.pnpm/pino@10.4.0/node_modules/pino/lib.js @nextskin/domain ops@example.org'
  expect(make().text(stack)).toBe(
    'at /srv/node_modules/.pnpm/pino@10.4.0/node_modules/pino/lib.js @nextskin/domain <邮箱1>',
  )
})

test('短的实例目录只换整段的路径开头，file:// 地址里的也换', () => {
  const redact = createDiagnosticsRedactor({ instanceDirectory: '/app', dataDirectory: '/data', homeDirectory: '/' })
  expect(redact.text('at f (/app/apps/web/.next/server/app/api/x.js:1:2) file:///app/server.js /data/logs')).toBe(
    'at f (<实例目录>/apps/web/.next/server/app/api/x.js:1:2) file://<实例目录>/server.js <数据目录>/logs',
  )
})

test('没有 @ 的长串不会让邮箱的正则回溯：1 MB 也在一秒内', () => {
  const started = performance.now()
  make().text('x'.repeat(1024 * 1024))
  expect(performance.now() - started).toBeLessThan(1000)
})

test('字段名紧跟冒号的 IPv6 照样替换，地址中间不另起候选', () => {
  expect(make().text('ip:2001:4860:4860::8888 peer:fe80::1')).toBe('ip:<IP1> peer:fe80::1')
})

test('file:// 地址里百分号编码的目录也换', () => {
  const redact = createDiagnosticsRedactor({
    instanceDirectory: 'C:\\Users\\Alice Smith\\NextSkin',
    dataDirectory: 'D:\\data',
    homeDirectory: 'C:\\Users\\Alice Smith',
  })
  expect(redact.text('file:///C:/Users/Alice%20Smith/NextSkin/server.js file:///c:/users/alice%20smith/x')).toBe(
    'file:///<实例目录>/server.js file:///~/x',
  )
})
