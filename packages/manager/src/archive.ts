import { createHash } from 'node:crypto'
import { closeSync, openSync, writeSync } from 'node:fs'
import { createReadStream } from 'node:fs'
import { access, mkdir, open, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Inflate } from 'fflate'
import { downloadUrls, type ReleaseEntry } from '@nextskin/updates'
import { ManagerError } from './types.ts'
import { renameRetry } from './state.ts'

export interface DownloadOptions {
  fetch?: typeof fetch
  signal?: AbortSignal
  connectionTimeout?: number
  onProgress?: (received: number, total: number) => void
  downloadTimeout?: number
}
export async function download(entry: ReleaseEntry, destination: string, options: DownloadOptions = {}): Promise<void> {
  await mkdir(dirname(destination), { recursive: true })
  for (const url of downloadUrls(entry)) {
    options.signal?.throwIfAborted()
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])])
    const connection = setTimeout(() => controller.abort(), options.connectionTimeout ?? 30_000)
    const total = setTimeout(() => controller.abort(), options.downloadTimeout ?? 30 * 60_000)
    let response: Response | undefined
    try {
      response = await (options.fetch ?? fetch)(url, { redirect: 'follow', signal })
      clearTimeout(connection)
      if (!response.ok || !response.body) throw new ManagerError('下载没有成功响应', 'download_failed')
      const file = await open(destination, 'w')
      try {
        const hash = createHash('sha256')
        let size = 0
        options.onProgress?.(0, entry.size)
        const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
        const abort = () => {
          void reader.cancel().catch(() => {})
        }
        signal.addEventListener('abort', abort, { once: true })
        try {
          for (;;) {
            signal.throwIfAborted()
            const { value, done } = await reader.read()
            if (done) break
            size += value.length
            if (size > entry.size) {
              controller.abort()
              throw new ManagerError('下载超过清单声明的大小', 'download_failed')
            }
            hash.update(value)
            await file.writeFile(value)
            options.onProgress?.(size, entry.size)
          }
        } finally {
          signal.removeEventListener('abort', abort)
          await reader.cancel().catch(() => {})
          reader.releaseLock()
        }
        signal.throwIfAborted()
        if (size !== entry.size || hash.digest('hex') !== entry.sha256)
          throw new ManagerError('下载的大小或 SHA-256 不一致', 'download_failed')
        return
      } finally {
        await file.close()
      }
    } catch {
      await rm(destination, { force: true })
      if (options.signal?.aborted) throw new ManagerError('操作已取消', 'download_failed')
    } finally {
      clearTimeout(connection)
      clearTimeout(total)
      await response?.body?.cancel().catch(() => {})
    }
  }
  throw new ManagerError('所有下载地址都失败了，或文件大小、SHA-256 不一致', 'download_failed')
}

interface Entry {
  name: string
  compressed: number
  size: number
  method: number
  offset: number
  flags: number
  dataEnd: number
}
function safePath(name: string): void {
  if (
    !name ||
    name.startsWith('/') ||
    name.includes('\\') ||
    name.includes(':') ||
    name.includes('\0') ||
    name
      .split('/')
      .some(
        (part) =>
          part === '..' ||
          part === '.' ||
          /[. ]$/.test(part) ||
          [...part].some((character) => character.charCodeAt(0) < 32) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
    throw new ManagerError('ZIP 含不安全路径', 'download_failed')
}
/** fflate 的流式 Unzip 不暴露 Unix 属性；先按条目读中央目录，检查链接后才解压。 */
async function entries(file: Awaited<ReturnType<typeof open>>): Promise<Entry[]> {
  const size = (await file.stat()).size
  const tail = Buffer.alloc(Math.min(size, 65_557))
  await file.read(tail, 0, tail.length, size - tail.length)
  let end = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) {
      end = i
      break
    }
  }
  if (
    end < 0 ||
    tail.readUInt16LE(end + 4) !== 0 ||
    tail.readUInt16LE(end + 6) !== 0 ||
    tail.readUInt16LE(end + 8) !== tail.readUInt16LE(end + 10)
  )
    throw new ManagerError('ZIP 中央目录不完整或是分卷文件', 'download_failed')
  const count = tail.readUInt16LE(end + 10)
  const length = tail.readUInt32LE(end + 12)
  let offset = tail.readUInt32LE(end + 16)
  const centralEnd = offset + length
  if (count === 0xffff || offset === 0xffffffff || centralEnd > size - tail.length + end)
    throw new ManagerError('不支持 ZIP64 或无效的 ZIP 中央目录', 'download_failed')
  const result: Entry[] = []
  let unpacked = 0
  for (let index = 0; index < count; index++) {
    const header = Buffer.alloc(46)
    if ((await file.read(header, 0, 46, offset)).bytesRead !== 46 || header.readUInt32LE(0) !== 0x02014b50)
      throw new ManagerError('ZIP 条目不完整', 'download_failed')
    const nameLength = header.readUInt16LE(28)
    const extraLength = header.readUInt16LE(30)
    const commentLength = header.readUInt16LE(32)
    const nameBytes = Buffer.alloc(nameLength)
    await file.read(nameBytes, 0, nameLength, offset + 46)
    const name = nameBytes.toString('utf8')
    safePath(name)
    const unixMode = header.readUInt32LE(38) >>> 16
    if ((unixMode & 0o170000) === 0o120000) throw new ManagerError('ZIP 不允许符号链接', 'download_failed')
    const item = {
      name,
      compressed: header.readUInt32LE(20),
      size: header.readUInt32LE(24),
      method: header.readUInt16LE(10),
      flags: header.readUInt16LE(8),
      offset: header.readUInt32LE(42),
      dataEnd: tail.readUInt32LE(end + 16),
    }
    if (
      item.flags & 1 ||
      ![0, 8].includes(item.method) ||
      item.offset + 30 + item.compressed > tail.readUInt32LE(end + 16)
    )
      throw new ManagerError('ZIP 压缩方式或条目位置不支持', 'download_failed')
    unpacked += item.size
    if (unpacked > 4 * 1024 ** 3) throw new ManagerError('ZIP 解压后超过 4 GiB 上限', 'download_failed')
    result.push(item)
    offset += 46 + nameLength + extraLength + commentLength
    if (offset > centralEnd) throw new ManagerError('ZIP 中央目录越界', 'download_failed')
  }
  if (offset !== centralEnd) throw new ManagerError('ZIP 中央目录长度不一致', 'download_failed')
  return result
}
export async function verifyRelease(home: string, version: string): Promise<void> {
  const root = join(home, 'releases', version)
  try {
    await access(join(root, 'nextskin.mjs'))
    await access(join(root, 'cli/main.mjs'))
    if ((await readFile(join(root, 'server/VERSION'), 'utf8')).trim() !== version) throw new Error('version')
  } catch {
    throw new ManagerError('发行目录不完整，或 server/VERSION 与目标版本不一致', 'preflight_failed')
  }
}
export async function extract(
  home: string,
  version: string,
  zip: string,
  protectedVersions: (string | null)[],
  signal?: AbortSignal,
): Promise<void> {
  if (protectedVersions.includes(version))
    throw new ManagerError('不能替换 current 或 previous 的版本目录', 'download_failed')
  const staging = join(home, 'releases/.staging')
  const target = join(staging, version)
  const manager = join(staging, `manager-${version}`)
  signal?.throwIfAborted()
  const file = await open(zip, 'r')
  try {
    const list = await entries(file)
    await rm(target, { recursive: true, force: true })
    await rm(manager, { recursive: true, force: true })
    await mkdir(target, { recursive: true })
    await mkdir(manager, { recursive: true })
    const seen = new Set<string>()
    for (const item of list) {
      signal?.throwIfAborted()
      const releasePrefix = `nextskin/releases/${version}/`
      const managerPrefix = 'nextskin/manager/'
      const destination = item.name.startsWith(releasePrefix)
        ? join(target, item.name.slice(releasePrefix.length))
        : item.name.startsWith(managerPrefix)
          ? join(manager, item.name.slice(managerPrefix.length))
          : null
      if (!destination) continue
      if (seen.has(destination)) throw new ManagerError('ZIP 有重复条目', 'download_failed')
      seen.add(destination)
      if (item.name.endsWith('/')) {
        await mkdir(destination, { recursive: true })
        continue
      }
      const local = Buffer.alloc(30)
      await file.read(local, 0, 30, item.offset)
      if (
        local.readUInt32LE(0) !== 0x04034b50 ||
        local.readUInt16LE(8) !== item.method ||
        local.readUInt16LE(6) !== item.flags
      )
        throw new ManagerError('ZIP 本地条目与中央目录不一致', 'download_failed')
      const nameLength = local.readUInt16LE(26)
      const name = Buffer.alloc(nameLength)
      await file.read(name, 0, nameLength, item.offset + 30)
      if (name.toString('utf8') !== item.name) throw new ManagerError('ZIP 本地路径与中央目录不一致', 'download_failed')
      const start = item.offset + 30 + nameLength + local.readUInt16LE(28)
      if (start + item.compressed > item.dataEnd) throw new ManagerError('ZIP 条目数据越界', 'download_failed')
      await mkdir(dirname(destination), { recursive: true })
      const fd = openSync(destination, 'wx')
      let written = 0
      const write = (data: Uint8Array) => {
        written += data.length
        if (written > item.size) throw new ManagerError('ZIP 条目超过声明大小', 'download_failed')
        let offset = 0
        while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset)
      }
      try {
        const inflate = item.method === 8 ? new Inflate((data) => write(data)) : null
        if (item.compressed) {
          const stream = createReadStream(zip, {
            start,
            end: start + item.compressed - 1,
            highWaterMark: 16 * 1024,
            signal,
          })
          for await (const chunk of stream) {
            if (inflate) inflate.push(chunk as Buffer)
            else write(chunk as Buffer)
          }
        }
        inflate?.push(new Uint8Array(), true)
        if (written !== item.size) throw new ManagerError('ZIP 条目大小不一致', 'download_failed')
      } finally {
        closeSync(fd)
      }
    }
    // 下载包一定带管理进程；手动解压不经过此函数。
    if (
      (await readFile(join(target, 'server/VERSION'), 'utf8')).trim() !== version ||
      (await readFile(join(manager, 'VERSION'), 'utf8')).trim() !== version
    )
      throw new ManagerError('ZIP 版本标记不一致', 'download_failed')
    for (const name of ['nextskin.mjs', 'cli/main.mjs']) {
      if (!(await stat(join(target, name))).isFile()) throw new ManagerError('ZIP 发行目录不完整', 'download_failed')
    }
    await access(join(manager, 'main.mjs'))
    signal?.throwIfAborted()
    await rm(join(home, 'releases', version), { recursive: true, force: true })
    // 杀毒软件会扫刚解压的整个目录，改名要等它扫完；Windows 上实测 4.5 秒常常不够
    await renameRetry(target, join(home, 'releases', version), { attempts: 60, signal })
  } finally {
    await file.close()
  }
}
