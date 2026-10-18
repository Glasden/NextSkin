import { describe, expect, test } from 'vitest'
import {
  conditionalResponse,
  httpDate,
  isJsonRequest,
  isNotModified,
  parseHttpDate,
  protocolMethodResponse,
  publicCacheResponse,
  uniqueProfileInputs,
  unsignedFromQuery,
  requestRoot,
  requiresSignature,
  siteRoot,
  skinDomains,
  suffixPlayer,
} from './http.ts'

describe('请求地址与站点地址', () => {
  test.each([
    ['http://internal:3000/path', {}, 'http://internal:3000'],
    ['https://internal/path', {}, 'http://internal'],
    ['http://internal/path', { host: 'SKIN.Example:80' }, 'http://skin.example'],
    ['https://internal/path', { host: 'SKIN.Example:443' }, 'http://skin.example:443'],
    ['http://internal/path', { host: 'SKIN.Example:443' }, 'http://skin.example:443'],
    ['http://internal/path', { host: 'SKIN.Example:80', 'x-forwarded-proto': 'https' }, 'https://skin.example'],
    ['https://internal/path', { host: 'SKIN.Example:80', 'x-forwarded-proto': 'http' }, 'http://skin.example'],
    ['http://internal/path', { 'x-forwarded-ssl': 'on' }, 'https://internal'],
    ['http://internal/path', { 'x-forwarded-proto': 'https,http' }, 'http://internal'],
    ['http://internal/path', { host: '[2001:DB8::1]:80' }, 'http://[2001:db8::1]'],
    ['https://internal/path', { 'x-forwarded-proto': 'https,http' }, 'http://internal'],
    ['https://internal/path', { 'x-forwarded-proto': 'HTTPS' }, 'http://internal'],
    ['https://internal/path', { 'x-forwarded-ssl': 'ON' }, 'http://internal'],
    ['http://internal/path', { host: 'SKIN.Example:0080' }, 'http://skin.example'],
    ['http://internal/path', { host: 'SKIN.Example:08443' }, 'http://skin.example:8443'],
    ['http://internal/path', { host: '[2001:DB8::1]:0080', 'x-forwarded-proto': 'https' }, 'https://[2001:db8::1]'],
  ])('%s %j → %s', (url, headers, expected) => {
    expect(requestRoot(new Request(url, { headers: headers as Record<string, string> }))).toBe(expected)
  })
  test('站点地址保留配置的主机、端口和路径，仅跟随请求 scheme', () => {
    expect(siteRoot('', 'http://example.test')).toBe('http://example.test')
    expect(siteRoot('http://site.test:8080/base///', 'https://proxy.test')).toBe('https://site.test:8080/base')
    expect(siteRoot('https://site.test/', 'http://proxy.test')).toBe('http://site.test')
  })
  test('skinDomains 先按顺序去重，再 trim，主机去端口转小写', () => {
    expect(
      skinDomains(
        ['cdn.test', 'site.test', ' cdn.test ', 'cdn.test'],
        'http://site.test:80/base',
        'https://OTHER.test:443',
      ),
    ).toEqual(['cdn.test', 'site.test', 'cdn.test', 'other.test'])
    expect(skinDomains([], '', 'http://example.test:8080')).toEqual(['example.test'])
  })
})

describe('HTTP 日期与条件请求', () => {
  const date = 'Fri, 02 Jan 2026 03:04:05 GMT'
  test('UTC 日期截掉毫秒', () => {
    expect(httpDate('2026-01-02T03:04:05.999Z')).toBe(date)
    expect(httpDate(new Date('2026-01-02T11:04:05+08:00'))).toBe(date)
  })
  test.each([
    [{ 'if-none-match': '"abc"' }, { etag: '"abc"' }, true],
    [{ 'if-none-match': 'W/"abc"' }, { etag: '"abc"' }, true],
    [{ 'if-none-match': '"abc"' }, { etag: 'W/"abc"' }, true],
    [{ 'if-none-match': '"other", W/"abc"' }, { etag: '"abc"' }, true],
    [{ 'if-none-match': '*' }, {}, true],
    [{ 'if-none-match': 'W/*' }, {}, true],
    [{ 'if-none-match': 'W/*' }, { etag: '"abc"' }, true],
    [{ 'if-none-match': '"abc"' }, {}, false],
    [{ 'if-none-match': '"other"', 'if-modified-since': date }, { etag: '"abc"', 'last-modified': date }, false],
    [{ 'if-none-match': ',,', 'if-modified-since': date }, { 'last-modified': date }, true],
    [{ 'if-modified-since': date }, { 'last-modified': date }, true],
    [{ 'if-modified-since': 'Fri, 02 Jan 2026 03:04:04 GMT' }, { 'last-modified': date }, false],
    [{ 'if-modified-since': 'Fri, 02 Jan 2026 03:04:06 GMT' }, { 'last-modified': date }, true],
    [{ 'if-modified-since': 'invalid' }, { 'last-modified': date }, false],
    [{ 'if-modified-since': 'Friday, 02-Jan-26 03:04:05 GMT' }, { 'last-modified': date }, true],
    [{ 'if-modified-since': 'Fri Jan 02 03:04:05 2026' }, { 'last-modified': date }, false],
    [{ 'if-modified-since': date }, { 'last-modified': 'Fri Jan 02 03:04:05 2026' }, false],
    [{ 'if-modified-since': date }, {}, false],
  ])('%j / %j → %s', (request, response, expected) => {
    expect(
      isNotModified(new Headers(request as Record<string, string>), new Headers(response as Record<string, string>)),
    ).toBe(expected)
  })
  test('304 保留缓存、ETag、ALI，去掉实体头和响应体', async () => {
    const result = conditionalResponse(
      new Request('http://example.test', { headers: { 'if-none-match': '*' } }),
      new Response('data', {
        headers: {
          Allow: 'GET, HEAD',
          'Content-Encoding': 'gzip',
          'Content-Language': 'en',
          'Content-MD5': 'digest',
          'Content-Type': 'image/png',
          'Content-Length': '4',
          'Last-Modified': date,
          ETag: '"abc"',
          'Cache-Control': 'max-age=12, public',
          'X-Authlib-Injector-API-Location': 'http://example.test/api/yggdrasil',
        },
      }),
    )
    expect(result.status).toBe(304)
    expect(await result.text()).toBe('')
    expect([...result.headers.keys()]).toEqual(['cache-control', 'etag', 'x-authlib-injector-api-location'])
  })
})

test.each([
  [undefined, false],
  ['', false],
  [' ', false],
  ['true', false],
  [' true\n', false],
  ['false', true],
  ['0', true],
  ['FALSE', true],
  ['TRUE', true],
  ['\u00a0true', true],
])('unsigned=%j 时签名：%s', (value, signed) => {
  expect(requiresSignature(value)).toBe(signed)
})

test.each([
  ['application/json', true],
  ['application/json; charset=utf-8', true],
  ['application/vnd.api+json', true],
  ['text/plain', false],
  [null, false],
])('Content-Type %j 是 JSON 请求：%s', (type, expected) => {
  const headers: Record<string, string> = type === null ? {} : { 'content-type': type }
  expect(isJsonRequest(new Request('http://example.test/', { method: 'POST', headers }))).toBe(expected)
})

test.each(['.json', 'Dot.Name.json', 'a/b.json', 'Steve.png'])('非法协议角色路径 %s', (value) => {
  expect(suffixPlayer(value, '.json')).toBeNull()
})
test('角色名按后缀拆出，保留空格与 Unicode', () => {
  expect(suffixPlayer('角色 .json', '.json')).toBe('角色 ')
})

describe('HTTP 日期解析', () => {
  const now = Date.UTC(2026, 9, 17, 12)
  test.each([
    ['Sun, 06 Nov 1994 08:49:37 GMT', Date.UTC(1994, 10, 6, 8, 49, 37)],
    ['Sunday, 06-Nov-94 08:49:37 GMT', Date.UTC(1994, 10, 6, 8, 49, 37)],
    ['Sunday, 02-Jan-26 03:04:05 GMT', Date.UTC(2026, 0, 2, 3, 4, 5)],
    ['Mon, 02 Jan 2026 03:04:05 GMT', Date.UTC(2026, 0, 2, 3, 4, 5)],
    ['Sunday, 17-Oct-76 12:00:00 GMT', Date.UTC(2076, 9, 17, 12)],
    ['Sunday, 17-Oct-76 12:00:01 GMT', Date.UTC(1976, 9, 17, 12, 0, 1)],
    ['Sun Nov  6 08:49:37 1994', null],
    ['Sun, 06 Nov 1994 08:49:37 UTC', null],
    ['Sun, 06 Nov 1994 08:49:37 +0000', null],
    ['Fri, 30 Feb 2026 03:04:05 GMT', null],
    ['Fri, 02 Jan 2026 24:04:05 GMT', null],
    ['Fri, 02 Jan 2026 03:60:05 GMT', null],
    ['Fri, 02 Jan 2026 03:04:60 GMT', null],
  ])('%s', (value, expected) => {
    expect(parseHttpDate(value, now)).toBe(expected)
  })
})

describe('方法响应', () => {
  test.each([
    ['GET', 'GET'],
    ['HEAD', 'GET'],
    ['POST', 'POST'],
  ] as const)('%s 是 %s 路由支持的方法', (method, allowed) => {
    expect(protocolMethodResponse(method, allowed)).toBeNull()
  })
  test.each([
    ['POST', 'GET', 405, 'GET, HEAD'],
    ['DELETE', 'GET', 405, 'GET, HEAD'],
    ['OPTIONS', 'GET', 200, 'GET,HEAD'],
    ['GET', 'POST', 405, 'POST'],
    ['HEAD', 'POST', 405, 'POST'],
    ['OPTIONS', 'POST', 200, 'POST'],
  ] as const)('%s / %s 路由', async (method, allowed, status, allow) => {
    const response = protocolMethodResponse(method, allowed)!
    expect(response.status).toBe(status)
    expect(response.headers.get('Allow')).toBe(allow)
    expect(response.headers.get('Cache-Control')).toBe('no-cache, private')
    expect(response.headers.get('Content-Type')).toBe(
      status === 200 ? 'text/html; charset=UTF-8' : 'text/plain; charset=UTF-8',
    )
    expect(await response.text()).toBe(status === 200 ? '' : 'Method Not Allowed')
  })
})

test.each([
  ['if-none-match', '*'],
  ['if-modified-since', 'Fri, 02 Jan 2099 03:04:05 GMT'],
])('HEAD 的公开响应忽略 %s，保留 GET 的实体头但不带 ETag', async (header, value) => {
  const response = publicCacheResponse(
    new Request('http://example.test', { method: 'HEAD', headers: { [header]: value } }),
    new Response('data', {
      headers: {
        'Last-Modified': 'Fri, 02 Jan 2026 03:04:05 GMT',
        ETag: '"abc"',
        'Content-Length': '4',
        'Content-Type': 'image/png',
      },
    }),
    86400,
  )
  expect(response.status).toBe(200)
  expect(await response.text()).toBe('')
  expect(Object.fromEntries(response.headers)).toEqual({
    'cache-control': 'private, must-revalidate',
    'content-length': '4',
    'content-type': 'image/png',
    'last-modified': 'Fri, 02 Jan 2026 03:04:05 GMT',
  })
})

test('HEAD 成功响应没有 Last-Modified 时用默认私有缓存头', () => {
  const response = publicCacheResponse(
    new Request('http://example.test', { method: 'HEAD' }),
    new Response('data'),
    86400,
  )
  expect(response.headers.get('Cache-Control')).toBe('no-cache, private')
})

test.each([
  ['', undefined, false],
  ['unsigned=true&unsigned=false', 'false', true],
  ['unsigned=false&unsigned=true', 'true', false],
  ['unsigned[]=true', [], true],
  ['unsigned=true&unsigned[x]=true', [], true],
  ['unsigned[x]=false&unsigned=true', 'true', false],
  ['unsigned[x][y]=true', [], true],
  ['unsigned=false&unsigned=%20true%0A', ' true\n', false],
  ['unsignedness=false&other=true', undefined, false],
  ['%75nsigned%5B%5D=true', [], true],
] as const)('按 PHP 查询串规则解析 %s', (query, value, signed) => {
  const result = unsignedFromQuery(new URLSearchParams(query))
  expect(result).toEqual(value)
  expect(requiresSignature(result)).toBe(signed)
})

describe('批量查询输入', () => {
  test.each([
    [null, true, []],
    [[], true, []],
    ['Steve', true, ['Steve']],
    [42, true, [42]],
    [false, true, [false]],
    [{ a: 'Steve', b: 'Alex_01' }, true, ['Steve', 'Alex_01']],
    [[' Steve', 'Steve ', '\tSteve\n', 'steve'], true, ['Steve', 'steve']],
    [['', ' \t', null, false, 'Steve'], true, [null, 'Steve']],
    [[null, false, '', true, 1, '1', 0, '0'], false, [null, true, 0]],
    [[1.5, '1.5', -2, '-2', -0, '0'], false, [1.5, -2, -0]],
    [[[], {}, ['Steve'], { a: 1 }, 'Array', 'Steve'], true, [[], 'Steve']],
    [[[' Steve '], ' Steve '], true, [[' Steve '], 'Steve']],
    [[' Steve ', '', null], false, [' Steve ', '']],
    [['Steve', 'Alex_01', 'HDSkin', null], true, ['Steve', 'Alex_01', 'HDSkin', null]],
    [[1, 2, 3, 4], true, [1, 2, 3, 4]],
    [[1e21, '1000000000000000000000'], false, [1e21]],
  ])('输入 %j，JSON trim=%s', (body, trim, expected) => {
    expect(uniqueProfileInputs(body, trim)).toEqual(expected)
  })
})
