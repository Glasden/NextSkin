import { expect, test } from 'vitest'
import { redactSecrets } from './redact.ts'

test.each([
  ['Authorization: Bearer abc.DEF-123', 'Authorization: [redacted]'],
  ['authorization: Basic dXNlcjpwYXNz', 'authorization: [redacted]'],
  ['Authorization: token FAKE_TOKEN', 'Authorization: [redacted]'],
  ['Proxy-Authorization: Basic dXNlcjpwYXNz', 'Proxy-Authorization: [redacted]'],
  ['Cookie: session=abc; theme=dark', 'Cookie: [redacted]'],
  ['set-cookie: a=b; Path=/', 'set-cookie: [redacted]'],
  ['{"cookie":"session=FAKE_COOKIE","path":"/"}', '{"cookie":"[redacted]","path":"/"}'],
  ['{ "authorization": "Bearer x\\"y", "ok": 1 }', '{ "authorization": "[redacted]", "ok": 1 }'],
  ['{"password":"hunter2"}', '{"password":"[redacted]"}'],
  ['retry with Bearer abcdefghijklmnop0123 later', 'retry with Bearer [redacted] later'],
  ['jwt eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl here', 'jwt [redacted] here'],
  ['connect mysql://root:hunter2@db:3306/skin failed', 'connect mysql://[redacted]@db:3306/skin failed'],
  ['postgres://user:@host/db', 'postgres://[redacted]@host/db'],
  ['postgres://:FAKE_PASSWORD@db/skin', 'postgres://[redacted]@db/skin'],
  ['mysql://root:p@ss@db/skin', 'mysql://[redacted]@db/skin'],
  ['GET /callback?code=abc123&state=xyz', 'GET /callback?code=[redacted]&state=xyz'],
  ['https://a.example/x?foo=1&access_token=t0k&b=2', 'https://a.example/x?foo=1&access_token=[redacted]&b=2'],
  ['Host=db;Password=hunter2;Database=skin', 'Host=db;Password=[redacted];Database=skin'],
  ['smtp api_key: sk-123 rejected', 'smtp api_key: [redacted] rejected'],
])('%s', (input, expected) => {
  expect(redactSecrets(input)).toBe(expected)
})

test('不像机密的照旧', () => {
  for (const text of [
    '▲ Next.js 16.4.2',
    '- Local:         http://127.0.0.1:3000',
    'Error: ENOENT: no such file or directory, open /data/x',
    'exit code=1',
    'mailto:steve@example.com',
    'Basic configuration loaded',
    'loading basic /data/plugins/plugin.mjs',
    'Bearer token expired',
    'password reset requested for uid 3',
    'http://127.0.0.1:3000/api/yggdrasil/',
  ])
    expect(redactSecrets(text)).toBe(text)
})

test('一行 2000 个字符的病态输入也很快', () => {
  const started = performance.now()
  for (const text of ['a://'.repeat(500), `{"token":"${'\\'.repeat(1990)}`, `x:${'@'.repeat(1998)}`, 'eyJ'.repeat(666)])
    redactSecrets(text)
  expect(performance.now() - started).toBeLessThan(200)
})
