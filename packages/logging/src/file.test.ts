import { mkdtemp, mkdir, readdir, readFile, rename, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { openLogFile, type LogFileSystem } from './file.ts'
import { createMemoryLogger } from './logger.ts'
import { open } from 'node:fs/promises'

const MB = 1024 * 1024
let directory: string
beforeEach(async () => {
  directory = join(await mkdtemp(join(tmpdir(), 'nextskin-log-')), 'logs')
})
afterEach(async () => {
  await rm(join(directory, '..'), { recursive: true, force: true })
})

const read = async (name: string) => (await readFile(join(directory, name), 'utf8')).split('\n').filter(Boolean)
const names = async () => (await readdir(directory)).sort()
const line = (index: number, size = 100) => `${String(index).padStart(6, '0')}${'x'.repeat(size - 6)}`

test('一条记录一行、接着写已有的文件；POSIX 上新文件的权限是 0600', async () => {
  await mkdir(directory)
  await writeFile(join(directory, 'nextskin.log'), 'old\n')
  const { logger } = createMemoryLogger()
  const file = openLogFile({ directory, report: logger })
  file.write('{"msg":"a"}')
  file.write('{"msg":"b"}')
  await file.close()
  file.write('{"msg":"closed"}')
  expect(await read('nextskin.log')).toEqual(['old', '{"msg":"a"}', '{"msg":"b"}'])
  const fresh = join(directory, '..', 'fresh')
  const other = openLogFile({ directory: fresh, report: logger })
  other.write('x')
  await other.close()
  if (process.platform !== 'win32') expect((await stat(join(fresh, 'nextskin.log'))).mode & 0o777).toBe(0o600)
})

test('超过上限就轮换：旧文件依次后移，连同当前文件只留 maxFiles 份，记录的顺序不乱', async () => {
  const { logger, records } = createMemoryLogger()
  const file = openLogFile({ directory, report: logger, limits: { maxFileSizeMb: 1, maxFiles: 3 } })
  const written = Array.from({ length: 300 }, (_, index) => line(index, 10_000))
  for (const item of written) file.write(item)
  await file.close()
  expect(await names()).toEqual(['nextskin.1.log', 'nextskin.2.log', 'nextskin.log'])
  for (const name of await names()) expect((await stat(join(directory, name))).size).toBeLessThanOrEqual(MB + 64 * 1024)
  const kept = [...(await read('nextskin.2.log')), ...(await read('nextskin.1.log')), ...(await read('nextskin.log'))]
  expect(kept).toEqual(written.slice(-kept.length))
  expect(kept.length).toBeGreaterThan(150)
  expect(records).toEqual([])
})

test('收到设置之前轮换不删旧文件；收到之后当场删掉超出份数的', async () => {
  await mkdir(directory)
  // 上次设了 8 份：按默认的 5 份删就丢了日志
  for (let index = 1; index <= 7; index++) await writeFile(join(directory, `nextskin.${index}.log`), `${index}\n`)
  await writeFile(join(directory, 'nextskin.log'), '')
  await truncate(join(directory, 'nextskin.log'), 10 * MB)
  const { logger } = createMemoryLogger()
  const file = openLogFile({ directory, report: logger })
  file.write('first')
  await file.flush()
  expect(await names()).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((index) => `nextskin.${index}.log`).concat('nextskin.log'))
  expect(await read('nextskin.8.log')).toEqual(['7'])
  expect(await read('nextskin.log')).toEqual(['first'])
  file.configure({ maxFileSizeMb: 10, maxFiles: 3 })
  await file.flush()
  expect(await names()).toEqual(['nextskin.1.log', 'nextskin.2.log', 'nextskin.log'])
  // 份数调大不删；之后调小再删
  file.configure({ maxFileSizeMb: 10, maxFiles: 20 })
  file.configure({ maxFileSizeMb: 10, maxFiles: 2 })
  await file.close()
  expect(await names()).toEqual(['nextskin.1.log', 'nextskin.log'])
})

test('大小调小后，当前文件超出的下一批记录就轮换', async () => {
  const { logger } = createMemoryLogger()
  const file = openLogFile({ directory, report: logger, limits: { maxFileSizeMb: 10, maxFiles: 5 } })
  for (let index = 0; index < 150; index++) file.write(line(index, 10_000))
  await file.flush()
  expect(await names()).toEqual(['nextskin.log'])
  file.configure({ maxFileSizeMb: 1, maxFiles: 5 })
  file.write('next')
  await file.close()
  expect(await names()).toEqual(['nextskin.1.log', 'nextskin.log'])
  expect(await read('nextskin.log')).toEqual(['next'])
})

test('排着等写盘的超过上限时丢掉新的，写盘之后补一条 warn 说丢了多少', async () => {
  const { logger, records } = createMemoryLogger()
  const file = openLogFile({ directory, report: logger, maxPending: 1000 })
  for (let index = 0; index < 20; index++) file.write(line(index))
  await file.close()
  expect(await read('nextskin.log')).toEqual(Array.from({ length: 9 }, (_, index) => line(index)))
  expect(records).toMatchObject([{ level: 'warn', msg: '有记录没写进日志文件', dropped: 11 }])
  expect(records).toHaveLength(1)
})

test('写盘失败（磁盘满）时丢掉记录、启动器照常运行；提示每 10 分钟最多一次，恢复之后补一条丢了多少', async () => {
  let clock = 0
  let full = true
  const fs: LogFileSystem = {
    mkdir,
    rename,
    rm,
    readdir,
    open: async (path, flags, mode) => {
      const handle = await open(path, flags, mode)
      return {
        stat: () => handle.stat(),
        close: () => handle.close(),
        appendFile: (data) =>
          full ? Promise.reject(Object.assign(new Error('no space'), { code: 'ENOSPC' })) : handle.appendFile(data),
      }
    },
  }
  const { logger, records } = createMemoryLogger()
  const file = openLogFile({ directory, report: logger, fs, now: () => clock })
  file.write('a')
  await file.flush()
  // 1 秒之内直接丢掉，不再去碰磁盘
  file.write('b')
  clock += 1000
  file.write('c')
  await file.flush()
  expect(records).toMatchObject([{ level: 'warn', msg: '日志文件写不进去，先丢掉新的记录', code: 'ENOSPC' }])
  full = false
  clock += 1000
  file.write('d')
  await file.close()
  expect(await read('nextskin.log')).toEqual(['d'])
  expect(records).toMatchObject([
    { msg: '日志文件写不进去，先丢掉新的记录' },
    { level: 'warn', msg: '有记录没写进日志文件', dropped: 3 },
  ])
  expect(records).toHaveLength(2)
})

test('轮换时改名失败（Windows 上文件被占着）：重试几次，还不行就接着写当前文件，下一批再试', async () => {
  let locked = true
  let attempts = 0
  const fs: LogFileSystem = {
    mkdir,
    open,
    rm,
    readdir,
    rename: async (from, to) => {
      if (from.endsWith('nextskin.log')) {
        attempts++
        if (locked) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      }
      await rename(from, to)
    },
  }
  const { logger, records } = createMemoryLogger()
  const file = openLogFile({
    directory,
    report: logger,
    fs,
    sleep: () => Promise.resolve(),
    limits: { maxFileSizeMb: 1, maxFiles: 3 },
  })
  for (let index = 0; index < 120; index++) file.write(line(index, 10_000))
  await file.flush()
  expect(await names()).toEqual(['nextskin.log'])
  expect(await read('nextskin.log')).toHaveLength(120)
  // 每次轮换改名重试 5 次
  const tried = attempts
  expect(tried).toBeGreaterThan(0)
  expect(tried % 5).toBe(0)
  file.write('again')
  await file.flush()
  expect(attempts).toBe(tried + 5)
  expect(records).toMatchObject([{ level: 'warn', msg: '日志文件轮换失败，接着写当前的文件', code: 'EBUSY' }])
  locked = false
  file.write('after')
  await file.close()
  expect(await names()).toEqual(['nextskin.1.log', 'nextskin.log'])
  expect(await read('nextskin.log')).toEqual(['after'])
  expect(records).toHaveLength(1)
})
