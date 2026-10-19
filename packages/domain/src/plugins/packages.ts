/**
 * 安装插件的包（ADR-0033"多实例"）。
 *
 * - 插件包按 sha256 存进存储接口：默认是本地磁盘，多实例部署时换成各实例共享的驱动（ADR-0002）；
 * - 每个实例自己把包解到 `data/plugins/{id}/{sha256}/`，换代之前把本地还没有的包取下来、校验后再解开。
 *   目录按包的 sha256 命名，不按版本号：两个版本号相同、内容不同的包（同时上传、卸载后重装）不会解到同一个目录，
 *   一个目录解开之后内容就不再变，正在运行它的 host 不会读到别的包的代码；
 * - 解开的目录里放一个记着 sha256 的标记文件，没有标记的目录不算解开了。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parsePluginManifest, sha256Hex, unpackPluginPackage, type PluginMessages } from '@nextskin/plugin-host'
import type { PluginManifest } from '@nextskin/plugin-sdk'

export interface PluginPackageStore {
  read(hash: string): Promise<Uint8Array | null>
  write(hash: string, bytes: Uint8Array): Promise<void>
  delete(hash: string): Promise<void>
}

/** 解开后放在本实例上的一个插件版本 */
export interface LocalPluginPackage {
  id: string
  version: string
  hash: string
  dir: string
  manifest: PluginManifest
  messages: PluginMessages
}

const MARKER = '.package-sha256'
const HASH = /^[0-9a-f]{64}$/
/** 刚解开的目录在这段时间里不清理：安装、升级时先解包，过一会儿才写插件表 */
const FRESH_MS = 10 * 60_000

function assertHash(hash: string) {
  if (!HASH.test(hash)) throw new Error('插件包的 hash 必须是 64 位小写十六进制')
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/** 本地磁盘上的插件包：`<目录>/<sha256>.tgz` */
export function createLocalPluginPackageStore(directory: string): PluginPackageStore {
  const file = (hash: string) => {
    assertHash(hash)
    return join(directory, `${hash}.tgz`)
  }
  return {
    async read(hash) {
      try {
        return new Uint8Array(await readFile(file(hash)))
      } catch (error) {
        if (isMissing(error)) return null
        throw error
      }
    },
    async write(hash, bytes) {
      const target = file(hash)
      await mkdir(directory, { recursive: true })
      const temp = `${target}.${randomUUID()}.tmp`
      await writeFile(temp, bytes)
      await rename(temp, target)
    },
    async delete(hash) {
      await rm(file(hash), { force: true })
    },
  }
}

async function readMessages(dir: string): Promise<PluginMessages> {
  const messages: Record<string, Record<string, unknown>> = {}
  let names: string[]
  try {
    names = await readdir(join(dir, 'locales'))
  } catch (error) {
    if (isMissing(error)) return messages
    throw error
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    messages[name.slice(0, -'.json'.length)] = JSON.parse(await readFile(join(dir, 'locales', name), 'utf8')) as Record<
      string,
      unknown
    >
  }
  return messages
}

export function createPluginPackages(options: {
  /** `data/plugins` */
  directory: string
  store: PluginPackageStore
}) {
  const { directory, store } = options
  const dirOf = (id: string, hash: string) => join(directory, id, hash)
  const fresh = new Map<string, number>()

  async function readLocal(id: string, hash: string): Promise<LocalPluginPackage | null> {
    const dir = dirOf(id, hash)
    let marker: string
    try {
      marker = (await readFile(join(dir, MARKER), 'utf8')).trim()
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
    if (marker !== hash) return null
    const manifest = parsePluginManifest(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')))
    if (manifest.id !== id) return null
    return { id, version: manifest.version, hash, dir, manifest, messages: await readMessages(dir) }
  }

  /**
   * 解到临时目录再改名：别的进程不会读到解了一半的目录。目标目录已经有了同一个包（另一个实例、另一次请求刚解开），
   * 就用已有的，不删它：可能有 host 正在读
   */
  async function extract(hash: string, bytes: Uint8Array): Promise<LocalPluginPackage> {
    const unpacked = unpackPluginPackage(bytes)
    const { id, version } = unpacked.manifest
    const dir = dirOf(id, hash)
    const existing = await readLocal(id, hash).catch(() => null)
    if (existing) return existing
    const temp = join(directory, id, `.${hash}.${randomUUID()}.tmp`)
    try {
      for (const [path, content] of unpacked.files) {
        const target = join(temp, ...path.split('/'))
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, content)
      }
      if (!unpacked.files.has('manifest.json')) {
        await mkdir(temp, { recursive: true })
        await writeFile(join(temp, 'manifest.json'), JSON.stringify(unpacked.manifest))
      }
      await writeFile(join(temp, MARKER), hash)
      try {
        await rename(temp, dir)
      } catch (error) {
        // 同时有人解开了同一个包：内容相同，用它的
        const raced = await readLocal(id, hash).catch(() => null)
        if (!raced) throw error
        await rm(temp, { recursive: true, force: true })
        fresh.set(dir, Date.now())
        return raced
      }
      fresh.set(dir, Date.now())
    } catch (error) {
      await rm(temp, { recursive: true, force: true })
      throw error
    }
    return { id, version, hash, dir, manifest: unpacked.manifest, messages: unpacked.messages }
  }

  return {
    store,
    dirOf,
    /**
     * 本实例上的这个版本：已经解开就直接用，否则从存储接口取包、按 sha256 校验后解开。
     * 存储里没有、校验不通过时返回 null，由调用方记日志
     */
    async ensure(id: string, version: string, hash: string): Promise<LocalPluginPackage | null> {
      assertHash(hash)
      const local = await readLocal(id, hash).catch(() => null)
      if (local) return local.version === version ? local : null
      const bytes = await store.read(hash)
      if (!bytes || sha256Hex(bytes) !== hash) return null
      const extracted = await extract(hash, bytes)
      if (extracted.id !== id || extracted.version !== version) return null
      return extracted
    },
    /** 安装、升级：包已经校验过，存进存储接口，再解到本实例 */
    async add(bytes: Uint8Array): Promise<LocalPluginPackage> {
      const hash = sha256Hex(bytes)
      await store.write(hash, bytes)
      return extract(hash, bytes)
    },
    /** 删掉本实例上解开的这个包；这个插件没有别的包了就连插件的目录一起删 */
    async removeLocal(id: string, hash: string): Promise<void> {
      assertHash(hash)
      const dir = dirOf(id, hash)
      fresh.delete(dir)
      await rm(dir, { recursive: true, force: true })
      const parent = join(directory, id)
      if (!(await readdir(parent).catch(() => [''])).length) await rm(parent, { recursive: true, force: true })
    },
    /**
     * 删掉不在 keep 里的包目录：卸载、升级之后旧的包留下的，每个实例清理自己的。
     * 点开头的是正在解开的临时目录，不碰
     */
    async prune(keep: ReadonlySet<string>): Promise<void> {
      let ids: string[]
      try {
        ids = await readdir(directory)
      } catch (error) {
        if (isMissing(error)) return
        throw error
      }
      const now = Date.now()
      for (const [dir, at] of fresh) if (now - at > FRESH_MS) fresh.delete(dir)
      for (const id of ids) {
        const parent = join(directory, id)
        const versions = await readdir(parent).catch(() => [] as string[])
        for (const version of versions) {
          const dir = join(parent, version)
          if (!version.startsWith('.') && !keep.has(dir) && !fresh.has(dir))
            await rm(dir, { recursive: true, force: true })
        }
        if (!(await readdir(parent).catch(() => [''])).length) await rm(parent, { recursive: true, force: true })
      }
    },
  }
}

export type PluginPackages = ReturnType<typeof createPluginPackages>
