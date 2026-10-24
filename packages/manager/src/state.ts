import { appendFile, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Logger } from '@nextskin/logging'
import { compareVersions } from '@nextskin/updates'
import { ConfigError, dialect, object, type Current, type UpdateLog } from './types.ts'

export function validVersion(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[0-9A-Za-z.+-]+$/.test(value)) return false
  try {
    compareVersions(value, value)
    return true
  } catch {
    return false
  }
}
/**
 * 待生效版本必须比当前运行的管理进程新，不能只看目录是否存在。命令行经根入口运行时也会把 manager.next 换进 manager，
 * 常驻的管理进程却还是旧的，所以磁盘上的 manager 比自己新也算待生效（重启一次就换上）。
 */
export async function pendingManager(home: string, bundled: string): Promise<string | null> {
  let pending: string | null = null
  for (const directory of ['manager.next', 'manager']) {
    try {
      const version = (await readFile(join(home, directory, 'VERSION'), 'utf8')).trim()
      if (validVersion(version) && compareVersions(version, pending ?? bundled) > 0) pending = version
    } catch {
      // 目录不在或读不了就是没有
    }
  }
  return pending
}
export function requireVersion(value: string): void {
  if (!validVersion(value)) throw new ConfigError('版本号必须符合 semver，不能是路径或地址')
}
export function initialCurrent(version: string): Current {
  requireVersion(version)
  return { schema: 1, current: version, previous: null, bundled: version, failed: [], upgrades: {} }
}
export function parseCurrent(value: unknown): Current {
  if (
    !object(value) ||
    value.schema !== 1 ||
    !validVersion(value.current) ||
    !(value.previous === null || validVersion(value.previous)) ||
    value.previous === value.current ||
    !validVersion(value.bundled) ||
    !Array.isArray(value.failed) ||
    !value.failed.every(validVersion) ||
    !object(value.upgrades)
  )
    throw new ConfigError('current.json 配置不合法，请检查版本指针')
  for (const [version, record] of Object.entries(value.upgrades)) {
    if (
      !validVersion(version) ||
      !object(record) ||
      !validVersion(record.from) ||
      typeof record.migrations !== 'boolean' ||
      !dialect(record.dialect) ||
      !(record.backup === null || (typeof record.backup === 'string' && isAbsolute(record.backup)))
    )
      throw new ConfigError('current.json 的升级记录不合法')
  }
  const upgrade = value.upgrades[value.current]
  if (
    value.previous !== null &&
    (!Object.hasOwn(value.upgrades, value.current) || !object(upgrade) || upgrade.from !== value.previous)
  )
    throw new ConfigError('current.json 缺少当前版本对应的升级记录，不能判断如何安全回滚')
  return value as unknown as Current
}
export async function readCurrent(home: string): Promise<Current | null> {
  let body: string
  try {
    body = await readFile(join(home, 'releases/current.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new ConfigError('无法读取 current.json，请检查目录权限')
  }
  try {
    return parseCurrent(JSON.parse(body))
  } catch (error) {
    if (error instanceof ConfigError) throw error
    throw new ConfigError('current.json 不是合法 JSON，请检查版本指针')
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
export async function renameRetry(
  from: string,
  to: string,
  options: { rename?: typeof rename; sleep?: typeof sleep } = {},
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await (options.rename ?? rename)(from, to)
      return
    } catch (error) {
      if (attempt >= 9 || !['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw error
      await (options.sleep ?? sleep)((attempt + 1) * 100)
    }
  }
}
export async function writeCurrent(home: string, current: Current): Promise<void> {
  parseCurrent(current)
  const destination = join(home, 'releases/current.json')
  await mkdir(dirname(destination), { recursive: true })
  const temporary = `${destination}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(current, null, 2) + '\n', { flag: 'wx' })
    await renameRetry(temporary, destination)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}
export async function appendLog(home: string, entry: UpdateLog): Promise<void> {
  await appendFile(join(home, 'releases/update-log.jsonl'), JSON.stringify(entry) + '\n')
}
export async function lastLog(home: string): Promise<UpdateLog | null> {
  try {
    const file = await open(join(home, 'releases/update-log.jsonl'), 'r')
    try {
      const size = (await file.stat()).size
      const buffer = Buffer.alloc(Math.min(size, 64 * 1024))
      await file.read(buffer, 0, buffer.length, size - buffer.length)
      const lines = buffer.toString('utf8').trimEnd().split('\n')
      const parsed: unknown = JSON.parse(lines.at(-1) ?? '')
      return object(parsed) &&
        typeof parsed.at === 'string' &&
        validVersion(parsed.from) &&
        validVersion(parsed.to) &&
        ['update', 'manual', 'legacy', 'rollback'].includes(String(parsed.kind)) &&
        ['success', 'rolled-back', 'failed'].includes(String(parsed.result)) &&
        typeof parsed.step === 'number'
        ? (parsed as unknown as UpdateLog)
        : null
    } finally {
      await file.close()
    }
  } catch {
    return null
  }
}

/** Windows 上占用中的版本留到下次启动再删，不能为清理失败停掉已健康的站点。 */
export async function pruneReleases(home: string, pointer: Current, log: Logger, keep: string[] = []): Promise<void> {
  for (const item of await readdir(join(home, 'releases'), { withFileTypes: true })) {
    if (
      item.isDirectory() &&
      validVersion(item.name) &&
      item.name !== pointer.current &&
      item.name !== pointer.previous &&
      !keep.includes(item.name)
    )
      await rm(join(home, 'releases', item.name), { recursive: true, force: true }).catch(() =>
        log.warn(`旧版本 ${item.name} 暂时无法删除，下次再清理`),
      )
  }
}
