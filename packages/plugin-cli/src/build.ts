import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as sdk from '@nextskin/plugin-sdk'
import {
  buildManifest,
  importPluginDefinition,
  installPluginModuleHooks,
  packPluginPackage,
  PLUGIN_EXTERNALS,
  sha256Hex,
  unpackPluginPackage,
  type AnyPluginDefinition,
} from '@nextskin/plugin-host'
import { rolldown } from 'rolldown'
import * as zod from 'zod'
import type { PluginManifest } from '@nextskin/plugin-sdk'

const packageSchema = zod.z.object({
  name: zod.z.string(),
  version: zod.z.string(),
  nextskin: zod.z.object({
    id: zod.z.string(),
    requires: zod.z.record(zod.z.string(), zod.z.string()).optional(),
    conflicts: zod.z.array(zod.z.string()).optional(),
  }),
})

/** 打包第三方插件；构建时会执行入口，调用方须信任插件源码。 */
export async function buildPluginPackage({ dir }: { dir: string }): Promise<{
  bytes: Uint8Array
  sha256: string
  manifest: PluginManifest
}> {
  const root = resolve(dir)
  let json: unknown
  try {
    json = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as unknown
  } catch {
    throw new Error('无法读取合法的 package.json')
  }
  const parsed = packageSchema.safeParse(json)
  if (!parsed.success) throw new Error(`package.json 的 ${parsed.error.issues[0]!.path.join('.')} 字段格式不对`)
  const pkg = parsed.data
  const entry = join(root, 'src', 'index.ts')
  try {
    await access(entry)
  } catch {
    throw new Error('插件缺少 src/index.ts 入口')
  }
  const temp = await mkdtemp(join(tmpdir(), 'nextskin-plugin-'))
  try {
    const server = join(temp, 'server.mjs')
    const bundle = await rolldown({
      input: entry,
      platform: 'node',
      external: (id) => isBuiltin(id) || (PLUGIN_EXTERNALS as readonly string[]).includes(id),
      onwarn(warning, warn) {
        if (warning.code === 'UNRESOLVED_IMPORT')
          throw new Error('依赖无法解析，请先安装依赖；其他依赖要打包进 server.mjs')
        warn(warning)
      },
      // 不把作者本机的绝对路径写进包，保证跨目录构建的结果一致。
      cwd: root,
    })
    try {
      await bundle.write({ file: server, format: 'esm', codeSplitting: false, minify: false })
    } finally {
      await bundle.close()
    }
    installPluginModuleHooks({ '@nextskin/plugin-sdk': sdk, zod })
    const definition = await importPluginDefinition(server)
    const extracted = buildManifest(definition as AnyPluginDefinition, pkg)
    const files = new Map<string, Uint8Array>([['server.mjs', await readFile(server)]])
    let locales: string[] = []
    try {
      locales = await readdir(join(root, 'locales'))
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    for (const name of locales.sort()) {
      if (!name.endsWith('.json')) continue
      const content = await readFile(join(root, 'locales', name))
      let value: unknown
      try {
        value = JSON.parse(content.toString('utf8')) as unknown
      } catch {
        throw new Error(`locales/${name} 不是合法的 JSON`)
      }
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error(`locales/${name} 的根值必须是 JSON 对象`)
      files.set(`locales/${name}`, content)
    }
    const manifest: PluginManifest = {
      ...extracted,
      entry: { server: 'server.mjs' },
      integrity: Object.fromEntries([...files].map(([path, content]) => [path, sha256Hex(content)])),
    }
    const bytes = packPluginPackage({ manifest, files })
    unpackPluginPackage(bytes)
    return { bytes, sha256: sha256Hex(bytes), manifest }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}
