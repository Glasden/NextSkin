import { fileURLToPath } from 'node:url'
import { pluginHostEntry } from '@nextskin/plugin-host'
import { expect, test } from 'vitest'
import { HostStartError, probePluginHost } from './host.ts'

const repository = fileURLToPath(new URL('../../../../', import.meta.url))

test('空的 plugin host 带权限模型启动、就绪并退出，不需要数据库或插件包', async () => {
  const entry = pluginHostEntry({ root: repository, bundled: false })
  await expect(probePluginHost(entry)).resolves.toBeUndefined()
})

test('入口不存在时报告 HostStartError', async () => {
  await expect(probePluginHost({ script: '/nextskin-absent-host.mjs', readPaths: [] })).rejects.toBeInstanceOf(
    HostStartError,
  )
})
