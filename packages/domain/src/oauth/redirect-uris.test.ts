import { expect, test } from 'vitest'
import { validateClientRedirectUri } from './redirect-uris.ts'
import type { OAuthClientType } from './clients.ts'

const https = ['https://example.com/cb', 'HTTPS://Example.com:443/a%2Fb?x=1']
const loopback = ['http://localhost:1234/cb', 'http://127.0.0.1/cb', 'http://[::1]:8080/cb']
const custom = ['com.example.app:/cb', 'cursor://host/cb']
const invalid = [
  '/relative',
  'http://example.com/cb',
  'http://localhost./cb',
  'https://localhost./cb',
  'https://localhost/cb',
  'https://127.0.0.1/cb',
  'https://127.1.2.3/cb',
  'https://[::1]/cb',
  'http://127.1/cb',
  'http://127.0.0.2/cb',
  'http://2130706433/cb',
  'http://app.localhost/cb',
  'https://example.com/cb#',
  'https://example.com/cb#part',
  'https://user@example.com/cb',
  'https://user:pass@example.com/cb',
  'javascript:alert(1)',
  'javascript://host/cb',
  'data:text/html,test',
  'file:///cb',
  'mailto:a@example.com',
  'app:/cb',
  'app://host',
]
for (const type of ['web', 'native'] satisfies OAuthClientType[]) {
  test.each([...https, ...(type === 'native' ? [...loopback, ...custom] : [])])(`${type} 接受 %s`, (uri) => {
    expect(() => validateClientRedirectUri(uri, type)).not.toThrow()
  })
  test.each([...invalid, ...(type === 'web' ? [...loopback, ...custom] : [])])(`${type} 拒绝 %s`, (uri) => {
    expect(() => validateClientRedirectUri(uri, type)).toThrow(
      expect.objectContaining({ code: 'oauth_redirect_uri_invalid', params: { uri, type } }),
    )
  })
}
