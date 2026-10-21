import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 站点图片的存储（ADR-0042）：和材质、插件包分开，材质的孤儿回收按材质表判断引用，放在一起会被它删掉。
 * 一张图两个文件：`<hash>.png` 和白底的 `<hash>.opaque.png`。list 也列出写到一半留下的临时文件，
 * 清理任务按开头的 hash 一并处理
 */
export interface SiteImageStorage {
  read(file: string): Promise<Uint8Array | null>
  has(file: string): Promise<boolean>
  write(file: string, bytes: Uint8Array): Promise<void>
  list(): Promise<{ file: string; modifiedAt: Date }[]>
  delete(file: string): Promise<void>
}

const FILE = /^[0-9a-f]{64}(?:\.opaque)?\.png$/
const TEMP = /^[0-9a-f]{64}(?:\.opaque)?\.png\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/

/** 公开地址里的文件名：`<hash>.png` 或 `<hash>.opaque.png` */
export function isSiteImageFile(file: string): boolean {
  return FILE.test(file)
}

export function siteImageFile(hash: string, variant: 'image' | 'opaque' = 'image'): string {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('站点图片的 hash 必须是 64 位小写十六进制')
  return variant === 'opaque' ? `${hash}.opaque.png` : `${hash}.png`
}

function assertFile(file: string, temp = false) {
  if (!FILE.test(file) && !(temp && TEMP.test(file))) throw new Error('站点图片的文件名不合法')
}

function isMissing(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

export function createLocalSiteImageStorage(directory: string): SiteImageStorage {
  // 不带 cause：底层异常里有本地存储的路径
  const failure = () => new Error('读写站点图片失败；请检查数据目录下的 site-images 目录和进程权限')
  return {
    async read(file) {
      assertFile(file)
      try {
        return new Uint8Array(await readFile(join(directory, file)))
      } catch (error) {
        if (isMissing(error)) return null
        throw failure()
      }
    },
    async has(file) {
      assertFile(file)
      try {
        return (await lstat(join(directory, file))).isFile()
      } catch (error) {
        if (isMissing(error)) return false
        throw failure()
      }
    },
    async write(file, bytes) {
      assertFile(file)
      const temp = join(directory, `${file}.${randomUUID()}.tmp`)
      try {
        await mkdir(directory, { recursive: true })
        await writeFile(temp, bytes)
        await rename(temp, join(directory, file))
      } catch {
        await rm(temp, { force: true }).catch(() => undefined)
        throw failure()
      }
    },
    async list() {
      const result: { file: string; modifiedAt: Date }[] = []
      try {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (!entry.isFile() || !(FILE.test(entry.name) || TEMP.test(entry.name))) continue
          try {
            result.push({ file: entry.name, modifiedAt: (await lstat(join(directory, entry.name))).mtime })
          } catch (error) {
            // 列出之后被并发删掉的不算
            if (!isMissing(error)) throw error
          }
        }
      } catch (error) {
        if (isMissing(error)) return []
        throw failure()
      }
      return result
    },
    async delete(file) {
      assertFile(file, true)
      try {
        await rm(join(directory, file), { force: true })
      } catch {
        throw failure()
      }
    },
  }
}

/** 测试和没有数据目录的场景用：存在进程内存里 */
export function createMemorySiteImageStorage(now: () => Date = () => new Date()): SiteImageStorage {
  const files = new Map<string, { bytes: Uint8Array; modifiedAt: Date }>()
  return {
    read(file) {
      assertFile(file)
      return Promise.resolve(files.get(file)?.bytes ?? null)
    },
    has(file) {
      assertFile(file)
      return Promise.resolve(files.has(file))
    },
    write(file, bytes) {
      assertFile(file)
      files.set(file, { bytes: bytes.slice(), modifiedAt: now() })
      return Promise.resolve()
    },
    list() {
      return Promise.resolve([...files].map(([file, { modifiedAt }]) => ({ file, modifiedAt })))
    },
    delete(file) {
      assertFile(file, true)
      files.delete(file)
      return Promise.resolve()
    },
  }
}
