import { mkdtemp, mkdir, writeFile, appendFile, rename, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { EXPORT_LOG_BYTES, LOG_LINE_BYTES, LOG_SCAN_BYTES, exportLogs, logStorage, readLogs } from './logs.ts'

// 在 readLogs 打开文件之前插一步，模拟列出文件和打开之间正好轮换
const hooks = vi.hoisted(() => ({ beforeOpen: null as (() => Promise<void>) | null }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const hook = hooks.beforeOpen
      hooks.beforeOpen = null
      await hook?.()
      return actual.open(...args)
    },
  }
})

let directory: string
const file = (index = 0) => join(directory, 'logs', index ? `nextskin.${index}.log` : 'nextskin.log')
const record = (msg: string, level = 'info', source = 'core') =>
  JSON.stringify({ time: '2026-10-24T00:00:00.000Z', level, source, msg })
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'diagnostics-'))
  await mkdir(join(directory, 'logs'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

test('无文件、空文件、半行和断号；空间统计跳过 limits.json', async () => {
  expect(await readLogs(directory)).toEqual({ available: false, entries: [], next: null, scanLimited: false })
  await writeFile(file(), '')
  expect(await readLogs(directory)).toMatchObject({ available: true, entries: [], next: null })
  await writeFile(file(), 'old\nnew\nhalf')
  await writeFile(file(2), 'after-gap\n')
  await writeFile(join(directory, 'logs', 'limits.json'), '{}')
  const page = await readLogs(directory)
  expect(page.entries.map((e) => e.line)).toEqual(['new', 'old'])
  expect(page.next).toBeNull()
  expect(await logStorage(directory)).toEqual({ logBytes: 12 + 10, logFiles: 2 })
})
test('解析未知字段，原始文本按 info 筛选；文字匹配不分大小写', async () => {
  const line = JSON.stringify({ ...JSON.parse(record('TeST', 'warn', 'plugin')), future: 42 })
  await writeFile(file(), `${record('debug', 'debug')}\nraw TEST\n${line}\n`)
  expect((await readLogs(directory, { level: 'info', text: 'test' })).entries).toHaveLength(2)
  const page = await readLogs(directory, { level: 'warn', source: 'plugin', text: 'TEST' })
  expect(page.entries).toHaveLength(1)
  expect(page.entries[0]!.record).toMatchObject({ future: 42 })
  expect((await readLogs(directory, { source: 'core', text: 'raw' })).entries).toEqual([])
})
test('分页 id 稳定；当前文件追加、两次轮换后游标仍指向同一文件，删除后翻到头', async () => {
  await writeFile(file(), 'one\ntwo\nthree\n')
  const all = await readLogs(directory)
  const first = await readLogs(directory, { limit: 1 })
  await appendFile(file(), 'four\n')
  await rename(file(), file(1))
  await writeFile(file(), 'new\n')
  await rename(file(1), file(2))
  await rename(file(), file(1))
  await writeFile(file(), 'newer\n')
  const second = await readLogs(directory, { limit: 1, cursor: first.next! })
  expect(second.entries[0]).toEqual(all.entries[1])
  const third = await readLogs(directory, { limit: 1, cursor: second.next! })
  expect(third.entries[0]).toEqual(all.entries[2])
  expect(third.next).toBeNull()
  await rm(file(2))
  expect(await readLogs(directory, { cursor: first.next! })).toMatchObject({ entries: [], next: null })
})
test.each(['', 'not-json', Buffer.from('{"v":1,"index":-1}').toString('base64url')])(
  '非法游标拒绝：%s',
  async (cursor) => {
    await expect(readLogs(directory, { cursor })).rejects.toMatchObject({ code: 'invalid_request', fields: ['cursor'] })
  },
)
test('16 KB 截断，8 MB 扫描截止在巨行中间也可以继续，关键字可在被截去的部分', async () => {
  const huge = 'a'.repeat(LOG_SCAN_BYTES + 100) + 'needle'
  await writeFile(file(), `old\n${huge}\n`)
  const first = await readLogs(directory, { text: 'needle' })
  expect(first).toMatchObject({ entries: [], scanLimited: true })
  const second = await readLogs(directory, { text: 'needle', cursor: first.next! })
  expect(second.entries).toHaveLength(1)
  expect(second.entries[0]!.line).toBe('a'.repeat(LOG_LINE_BYTES) + '…')
  expect(second.next).toBeNull()
  await expect(readLogs(directory, { text: 'different', cursor: first.next! })).rejects.toMatchObject({
    code: 'invalid_request',
  })
})
test('筛选扫描满 8 MB 时返回继续游标，跨块的 UTF-8 和关键字保持完整', async () => {
  await writeFile(file(1), 'old match\n')
  await writeFile(file(), ('a'.repeat(1023) + '\n').repeat(LOG_SCAN_BYTES / 1024 + 1))
  const first = await readLogs(directory, { text: 'match' })
  expect(first).toMatchObject({ entries: [], scanLimited: true })
  expect((await readLogs(directory, { text: 'match', cursor: first.next! })).entries[0]!.line).toBe('old match')
  const line = '头'.repeat(21845) + '关键字末尾'
  await writeFile(file(), line + '\n')
  expect((await readLogs(directory, { text: '关键字' })).entries).toHaveLength(1)
})
test('导出原名、完整行、最多 10 MB，最旧文件只取结尾且忽略半行', async () => {
  await writeFile(file(), 'latest\nhalf')
  await writeFile(file(1), ('x'.repeat(1023) + '\n').repeat(EXPORT_LOG_BYTES / 1024 + 1))
  const logs = await exportLogs(directory)
  expect(logs.map((log) => log.name)).toEqual(['nextskin.log', 'nextskin.1.log'])
  expect(logs[0]!.bytes.toString()).toBe('latest\n')
  expect(logs.reduce((sum, log) => sum + log.bytes.length, 0)).toBeLessThanOrEqual(EXPORT_LOG_BYTES)
  expect(logs[1]!.bytes[0]).toBe('x'.charCodeAt(0))
  expect(logs[1]!.bytes.at(-1)).toBe(10)
})

test('空行也是原始文本，文件开头的空行能够跨页读取', async () => {
  await writeFile(file(), '\nnew\n')
  const first = await readLogs(directory, { limit: 1 })
  expect(first.entries.map((entry) => entry.line)).toEqual(['new'])
  expect((await readLogs(directory, { cursor: first.next! })).entries.map((entry) => entry.line)).toEqual([''])
})

test('结构化长行：级别和来源筛选用完整记录，发给页面的 line 和 record 都缩短', async () => {
  const fields = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`f${i}`, i]))
  const original = JSON.stringify({
    ...fields,
    ...JSON.parse(record('x'.repeat(LOG_LINE_BYTES * 2), 'error', 'plugin')),
  })
  await writeFile(file(), original + '\n')
  const page = await readLogs(directory, { level: 'error', source: 'plugin' })
  expect(page.entries).toHaveLength(1)
  expect(page.entries[0]!.line.endsWith('…')).toBe(true)
  const shrunk = page.entries[0]!.record!
  expect(shrunk).toMatchObject({ level: 'error', source: 'plugin', time: '2026-10-24T00:00:00.000Z' })
  expect(shrunk.msg).toBe('x'.repeat(1000) + '…')
  expect(Object.keys(shrunk)).toHaveLength(50 + 4)
})

test('扫描预算落在长 JSON 中间时，下一页重读这一行并保留完整 record', async () => {
  const original = record('match' + 'x'.repeat(LOG_LINE_BYTES * 2), 'warn', 'plugin')
  const newer = ('n'.repeat(1023) + '\n').repeat(LOG_SCAN_BYTES / 1024 - 2)
  await writeFile(file(), original + '\n' + newer)
  const first = await readLogs(directory, { text: 'match', source: 'plugin' })
  expect(first).toMatchObject({ entries: [], scanLimited: true })
  const second = await readLogs(directory, { text: 'match', source: 'plugin', cursor: first.next! })
  expect(second.entries[0]!.record).toMatchObject({ level: 'warn', source: 'plugin' })
  expect(second.entries[0]!.record!.msg.startsWith('match')).toBe(true)
  expect(second.next).toBeNull()
})

test('列出文件之后、打开之前轮换：返回原来的游标，下一次在新的编号里接着读', async () => {
  await writeFile(file(), 'older\nnewer\n')
  const first = await readLogs(directory, { limit: 1 })
  hooks.beforeOpen = async () => {
    await rename(file(), file(1))
    await writeFile(file(), 'fresh\n')
  }
  const raced = await readLogs(directory, { cursor: first.next! })
  expect(raced.entries).toEqual([])
  expect(raced.next).not.toBeNull()
  expect((await readLogs(directory, { cursor: raced.next! })).entries.map((entry) => entry.line)).toEqual(['older'])
})

test('不跟符号链接：链接到日志目录以外的文件既不读、不导出，也不算进空间', async (context) => {
  const outside = join(directory, 'outside.txt')
  await writeFile(outside, 'outside-the-log-directory\n')
  try {
    await symlink(outside, file(), 'file')
  } catch (error) {
    // Windows 没开开发者模式的账号建不了文件的符号链接
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return context.skip()
    throw error
  }
  expect(await readLogs(directory)).toMatchObject({ available: false, entries: [] })
  expect(await exportLogs(directory)).toEqual([])
  expect(await logStorage(directory)).toEqual({ logBytes: 0, logFiles: 0 })
})
