import { expect, test } from 'vitest'
import { redactSecrets } from './redact.ts'

test.each([
  ['Authorization: Bearer abc.DEF-123', 'Authorization: Bearer [redacted]'],
  ['authorization: Basic dXNlcjpwYXNz', 'authorization: Basic [redacted]'],
  ['Authorization: token-without-scheme', 'Authorization: [redacted]'],
  ['Cookie: session=abc; theme=dark', 'Cookie: [redacted]'],
  ['set-cookie: a=b; Path=/', 'set-cookie: [redacted]'],
  ['jwt eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl here', 'jwt [redacted] here'],
  ['connect mysql://root:hunter2@db:3306/skin failed', 'connect mysql://[redacted]@db:3306/skin failed'],
  ['postgres://user:@host/db', 'postgres://[redacted]@host/db'],
  ['GET /callback?code=abc123&state=xyz', 'GET /callback?code=[redacted]&state=xyz'],
  ['https://a.example/x?foo=1&access_token=t0k&b=2', 'https://a.example/x?foo=1&access_token=[redacted]&b=2'],
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
  ])
    expect(redactSecrets(text)).toBe(text)
})
