import { buildManifest } from '@nextskin/plugin-host'
import { expect, test } from 'vitest'
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

test('手填的地址只认本站的', () => {
  const base = 'https://skin.example.test'
  expect(normalizePath('/csl/Steve.json', base)).toBe('/csl/Steve.json')
  expect(normalizePath('https://skin.example.test/textures/abc?x=1', base)).toBe('/textures/abc?x=1')
  expect(normalizePath('https://evil.test/a', base)).toBeNull()
  expect(normalizePath('   ', base)).toBeNull()
})
