import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { removeTestDirectory } from '@nextskin/db/testing'
import { pluginHostEntry } from '@nextskin/plugin-host'
import { afterAll } from 'vitest'
import { createLocalPluginPackageStore, createPluginPackages } from './packages.ts'

const exec = promisify(execFile)
export const repository = fileURLToPath(new URL('../../../../', import.meta.url))
const cli = join(repository, 'packages', 'plugin-cli', 'src', 'cli.ts')

/** 开发和测试时 host 直接运行 plugin-host 的源码 */
export const hostEntry = pluginHostEntry({ root: repository, bundled: false })

const work = mkdtemp(join(tmpdir(), 'nextskin-plugin-packages-'))
afterAll(async () => removeTestDirectory(await work))
const built = new Map<string, Promise<Uint8Array>>()

/**
 * 用 `nextskin-plugin build` 打一个插件包（和插件作者用的是同一个命令）。
 * `source` 是 `src/index.ts` 的内容；`from` 是仓库里现成的插件目录（例如 `plugins/invitation-codes`）。
 * 同样的参数在一个测试文件里只构建一次
 */
export function buildPackage(
  options: {
    id: string
    version?: string
    locales?: Record<string, unknown>
    /** package.json 里 `nextskin` 的其余字段，例如 `conflicts` */
    nextskin?: Record<string, unknown>
  } & ({ source: string; from?: undefined } | { from: string; source?: undefined }),
): Promise<Uint8Array> {
  const key = JSON.stringify(options)
  let found = built.get(key)
  if (!found) {
    found = (async () => {
      const dir = await mkdtemp(join(await work, `${options.id}-`))
      if (options.from) {
        await cp(join(repository, options.from, 'src'), join(dir, 'src'), { recursive: true })
        await cp(join(repository, options.from, 'locales'), join(dir, 'locales'), { recursive: true })
      } else if (options.source !== undefined) {
        await mkdir(join(dir, 'src'))
        await writeFile(join(dir, 'src', 'index.ts'), options.source)
        for (const [locale, messages] of Object.entries(options.locales ?? {})) {
          await mkdir(join(dir, 'locales'), { recursive: true })
          await writeFile(join(dir, 'locales', `${locale}.json`), JSON.stringify(messages))
        }
      }
      // 构建命令按插件项目里装的 SDK 算 `api`，像插件作者的项目一样把它装进 node_modules
      await mkdir(join(dir, 'node_modules', '@nextskin'), { recursive: true })
      await symlink(
        join(repository, 'packages', 'plugin-sdk'),
        join(dir, 'node_modules', '@nextskin', 'plugin-sdk'),
        'junction',
      )
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: `@test/${options.id}`,
          version: options.version ?? '1.0.0',
          nextskin: { ...options.nextskin, id: options.id },
        }),
      )
      const out = join(dir, 'plugin.tgz')
      await exec(process.execPath, [cli, 'build', dir, '--out', out], { timeout: 60_000 })
      return new Uint8Array(await readFile(out))
    })()
    built.set(key, found)
  }
  return found
}

/** 一个实例的插件包存储和解包目录 */
export async function pluginPackages() {
  const dir = await mkdtemp(join(await work, 'data-'))
  return {
    dir,
    packages: createPluginPackages({
      directory: join(dir, 'plugins'),
      store: createLocalPluginPackageStore(join(dir, 'plugin-packages')),
    }),
  }
}
