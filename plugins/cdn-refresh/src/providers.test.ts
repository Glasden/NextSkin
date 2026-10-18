import { expect, test } from 'vitest'
import { aliyunSignature, refreshAliyun, refreshAzure, refreshTencent, tencentAuthorization } from './providers.ts'

const credentials = { accessKeyId: 'id', accessKeySecret: 'secret' }

test('阿里云的签名和官方文档的示例一致', async () => {
  // https://help.aliyun.com/document_detail/25492.html 的 DescribeRegions 示例
  const { signature } = await aliyunSignature(
    'GET',
    {
      AccessKeyId: 'testid',
      Action: 'DescribeRegions',
      Format: 'XML',
      SignatureMethod: 'HMAC-SHA1',
      SignatureNonce: '3ee8c1b8-83d3-44af-a94f-4e0ad82fd6cf',
      SignatureVersion: '1.0',
      Timestamp: '2016-02-23T12:46:24Z',
      Version: '2014-05-26',
    },
    'testsecret',
  )
  expect(signature).toBe('OLeaidS1JvxuMvnyHOwuJ+uX5qY=')
})

test('腾讯云的 TC3 签名和官方文档的示例一致', async () => {
  // 腾讯云 API 3.0 签名文档的 DescribeInstances 示例
  const payload = '{"Limit": 1, "Filters": [{"Values": ["\\u672a\\u547d\\u540d"], "Name": "instance-name"}]}'
  const authorization = await tencentAuthorization(
    payload,
    { accessKeyId: 'AKIDz8krbsJ5yKBZQpn74WFkmLPx3EXAMPLE', accessKeySecret: 'Gu5t9xGARNpq86cd98joQYCN3EXAMPLE' },
    1551113065,
    'cvm',
    'cvm.tencentcloudapi.com',
  )
  expect(authorization).toBe(
    'TC3-HMAC-SHA256 Credential=AKIDz8krbsJ5yKBZQpn74WFkmLPx3EXAMPLE/2019-02-25/cvm/tc3_request, ' +
      'SignedHeaders=content-type;host, Signature=72e494ea809ad7a8c8f7a4507b9bddcbaa8e581f516e8da2f66e2c5a96525168',
  )
})

test('阿里云：一次请求带上全部地址，HTTP 出错就抛错', async () => {
  const requests: Request[] = []
  await refreshAliyun(['https://a.test/x', 'https://a.test/y'], credentials, (request) => {
    requests.push(request)
    return Promise.resolve(Response.json({ RefreshTaskId: '1' }))
  })
  const url = new URL(requests[0]!.url)
  expect(url.origin).toBe('https://cdn.aliyuncs.com')
  expect(url.searchParams.get('Action')).toBe('RefreshObjectCaches')
  expect(url.searchParams.get('ObjectPath')).toBe('https://a.test/x\nhttps://a.test/y')
  expect(url.searchParams.get('Signature')).toBeTruthy()
  await expect(
    refreshAliyun(['https://a.test/x'], credentials, () =>
      Promise.resolve(Response.json({ Code: 'InvalidAccessKeyId.NotFound' }, { status: 404 })),
    ),
  ).rejects.toThrow(/HTTP 404 .*InvalidAccessKeyId/)
})

test('腾讯云：HTTP 200 但 Response.Error 有值时也抛错', async () => {
  let request: Request | undefined
  await refreshTencent(['https://a.test/x'], credentials, (input) => {
    request = input
    return Promise.resolve(Response.json({ Response: { RequestId: 'r' } }))
  })
  expect(request!.headers.get('x-tc-action')).toBe('PurgeUrlsCache')
  expect(request!.headers.get('authorization')).toMatch(/^TC3-HMAC-SHA256 Credential=id\//)
  expect(await request!.json()).toEqual({ Urls: ['https://a.test/x'] })
  await expect(
    refreshTencent(['https://a.test/x'], credentials, () =>
      Promise.resolve(Response.json({ Response: { Error: { Code: 'AuthFailure', Message: 'bad' } } })),
    ),
  ).rejects.toThrow('AuthFailure bad')
})

test('Azure：先换令牌，再清除终结点上的路径', async () => {
  const requests: Request[] = []
  await refreshAzure(
    ['/textures/abc'],
    credentials,
    { tenantId: 't', subscriptionId: 's', resourceGroup: 'g', profile: 'p', endpoint: 'e' },
    (request) => {
      requests.push(request)
      return Promise.resolve(
        requests.length === 1 ? Response.json({ access_token: 'token' }) : new Response(null, { status: 202 }),
      )
    },
  )
  expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
    '/t/oauth2/v2.0/token',
    '/subscriptions/s/resourceGroups/g/providers/Microsoft.Cdn/profiles/p/afdEndpoints/e/purge',
  ])
  expect(new URLSearchParams(await requests[0]!.text()).get('client_secret')).toBe('secret')
  expect(requests[1]!.headers.get('authorization')).toBe('Bearer token')
  expect(await requests[1]!.json()).toEqual({ contentPaths: ['/textures/abc'] })
})
