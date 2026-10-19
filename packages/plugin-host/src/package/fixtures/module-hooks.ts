/** 只在独立 Node 进程里执行，不能把进程级钩子装进 vitest worker。 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as sdk from '@nextskin/plugin-sdk'
import * as zod from 'zod'
import { importPluginDefinition, installPluginModuleHooks } from '../module-loader.ts'
import { describePlugin } from '../../manifest.ts'

const temp = await mkdtemp(join(tmpdir(), 'nextskin-hooks-'))
try {
  await writeFile(join(temp, 'relative.mjs'), 'export default 42')
  await writeFile(
    join(temp, 'success.mjs'),
    `
    import { z, default as zDefault, enum as enumSchema } from 'zod'
    import { definePlugin, secret } from '@nextskin/plugin-sdk'
    import { isBuiltin } from 'node:module'
    import { basename } from 'path'
    import relative from './relative.mjs'
    export default { z, zDefault, enumSchema, relative, builtin: isBuiltin('path') && basename('x') === 'x', definition: definePlugin({ capabilities: [], settings: z.object({ token: secret() }) }) }
  `,
  )
  await writeFile(join(temp, 'bare.mjs'), "import 'other-package'; export default {}")
  await writeFile(join(temp, 'no-default.mjs'), 'export const definition = {}')
  installPluginModuleHooks({ '@nextskin/plugin-sdk': sdk, zod })
  installPluginModuleHooks({ '@nextskin/plugin-sdk': {}, zod: {} })
  const loaded = (await importPluginDefinition(join(temp, 'success.mjs'))) as {
    z: unknown
    zDefault: unknown
    enumSchema: unknown
    relative: number
    builtin: boolean
    definition: Parameters<typeof describePlugin>[0]
  }
  assert.equal(loaded.z, zod.z)
  assert.equal(loaded.zDefault, zod.default)
  assert.equal(loaded.enumSchema, zod.enum)
  assert.equal(loaded.relative, 42)
  assert.equal(loaded.builtin, true)
  const schema = describePlugin(loaded.definition).settingsSchema
  assert.equal((schema?.properties as Record<string, { writeOnly: boolean }>).token?.writeOnly, true)
  await assert.rejects(importPluginDefinition(join(temp, 'bare.mjs')), /其他依赖要打包进 server.mjs/)
  await assert.rejects(importPluginDefinition(join(temp, 'no-default.mjs')), /default/)
  await assert.rejects(importPluginDefinition('relative.mjs'), /绝对路径/)
} finally {
  await rm(temp, { recursive: true, force: true })
}
