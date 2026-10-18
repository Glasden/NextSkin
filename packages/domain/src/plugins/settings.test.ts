import { buildManifest } from '@nextskin/plugin-host'
import { definePlugin, secret, z } from '@nextskin/plugin-sdk'
import { expect, test } from 'vitest'
import { settingProperties } from './settings.ts'

function manifest(settings: z.ZodObject) {
  return buildManifest(definePlugin({ capabilities: [], settings }), {
    name: '@test/a',
    version: '1.0.0',
    nextskin: { id: 'a' },
  })
}

test('机密只能是顶层的一项：嵌在数组、对象里的 secret() 在插件加载时就拒绝', () => {
  expect(settingProperties(manifest(z.object({ token: secret() })))).toMatchObject([{ key: 'token', secret: true }])
  expect(() => settingProperties(manifest(z.object({ tokens: z.array(secret()) })))).toThrow(/机密只能是顶层的一项/)
  expect(() => settingProperties(manifest(z.object({ nested: z.object({ token: secret() }) })))).toThrow(
    /机密只能是顶层的一项/,
  )
})
