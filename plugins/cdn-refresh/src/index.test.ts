import { buildManifest } from '@nextskin/plugin-host'
import { expect, test, vi } from 'vitest'
import { normalizePath, playerPaths } from './index.ts'
import plugin from './official.ts'

test('manifest 能从定义里提取出来，机密设置标成 writeOnly', () => {
  const manifest = buildManifest(plugin.definition, plugin.package)
  expect(manifest).toMatchObject({
    id: 'cdn-refresh',
    capabilities: [],
    network: [
      'https://cdn.aliyuncs.com',
      'https://cdn.tencentcloudapi.com',
      'https://login.microsoftonline.com',
      'https://management.azure.com',
    ],
    jobs: [{ name: 'refresh', maxAttempts: 5, timeoutMs: 30_000 }],
  })
  expect([...manifest.events].sort()).toEqual([
    'player.deleted',
    'player.renamed',
    'player.texturesChanged',
    'player.transferred',
    'texture.deleted',
  ])
  const properties = (manifest.settingsSchema as { properties: Record<string, { writeOnly?: boolean }> }).properties
  expect(properties.accessKeySecret?.writeOnly).toBe(true)
  expect(properties.accessKeyId?.writeOnly).toBeUndefined()
})

test('选 Azure 时 Azure 的几项必填', () => {
  const settings = plugin.definition.settings!
  const base = { accessKeyId: 'id', accessKeySecret: 'secret' }
  expect(settings.safeParse(base).success).toBe(true)
  const result = settings.safeParse({ ...base, provider: 'azure', azureTenantId: 't' })
  expect(result.success).toBe(false)
  expect(result.error?.issues.map((issue) => issue.path[0])).toEqual([
    'azureSubscriptionId',
    'azureResourceGroup',
    'azureProfile',
    'azureEndpoint',
  ])
})

test('角色名的地址按 URL 编码', () => {
  expect(playerPaths('史蒂夫')).toContain('/csl/%E5%8F%B2%E8%92%82%E5%A4%AB.json')
  expect(playerPaths('Steve')).toEqual([
    '/Steve.json',
    '/csl/Steve.json',
    '/usm/Steve.json',
    '/skin/Steve.png',
    '/cape/Steve.png',
  ])
})

test('角色转让后刷新事件里角色名字的那组地址', async () => {
  const requests: URL[] = []
  const handler = plugin.definition.on!['player.transferred']!
  await handler({
    event: {
      id: 'transfer-1',
      name: 'player.transferred',
      occurredAt: '2026-10-19T00:00:00.000Z',
      actor: { kind: 'user', uid: 1, role: 'admin' },
      data: {
        player: {
          pid: 1,
          uid: 3,
          name: 'Alex',
          uuid: '0123456789abcdef0123456789abcdef',
          skin: null,
          cape: null,
          updatedAt: '2026-10-19T00:00:00.000Z',
        },
        previousUid: 2,
      },
    },
    ctx: {
      plugin: { id: 'cdn-refresh', version: '1.0.0' },
      site: { url: 'https://skin.example.test', name: 'NextSkin' },
      settings: plugin.definition.settings!.parse({ accessKeyId: 'id', accessKeySecret: 'secret' }),
      t: (key) => key,
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      signal: new AbortController().signal,
      jobs: { enqueue: vi.fn() },
      fetch: async (input) => {
        requests.push(new URL(input))
        return Response.json({ RefreshTaskId: '1' })
      },
    },
  })
  expect(requests).toHaveLength(1)
  expect(requests[0]!.searchParams.get('ObjectPath')?.split('\n')).toEqual([
    'https://skin.example.test/Alex.json',
    'https://skin.example.test/csl/Alex.json',
    'https://skin.example.test/usm/Alex.json',
    'https://skin.example.test/skin/Alex.png',
    'https://skin.example.test/cape/Alex.png',
  ])
})

test('手填的地址只认本站的', () => {
  const base = 'https://skin.example.test'
  expect(normalizePath('/csl/Steve.json', base)).toBe('/csl/Steve.json')
  expect(normalizePath('https://skin.example.test/textures/abc?x=1', base)).toBe('/textures/abc?x=1')
  expect(normalizePath('https://evil.test/a', base)).toBeNull()
  expect(normalizePath('   ', base)).toBeNull()
})
