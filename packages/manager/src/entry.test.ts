import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile, rename, rm, mkdir, writeFile, copyFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { checkNode, compareVersions, promoteManager } from '../release/nextskin.mjs'
import { fixture, contains } from './fixtures.ts'
import { initialCurrent, parseCurrent, readCurrent, renameRetry, writeCurrent } from './state.ts'

const disposers: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
})
async function setup() {
  const f = await fixture()
  disposers.push(f.dispose)
  return f
}

describe('根入口', () => {
  it('旧 Node 返回可读提示的版本门槛，semver 包含预发布和构建元数据', () => {
    expect(checkNode('22.0.0')).toBe(false)
    expect(checkNode('24.0.0')).toBe(true)
    for (const [a, b] of [
      ['1.0.0-alpha.2', '1.0.0-alpha.10'],
      ['1.0.0-9', '1.0.0-a'],
      ['1.0.0-rc.1', '1.0.0'],
      ['1.0.0', '1.1.0'],
    ])
      expect(compareVersions(a!, b!)).toBeLessThan(0)
    expect(compareVersions('1.0.0+build.1', '1.0.0+build.2')).toBe(0)
    expect(() => compareVersions('1.0.0-01', '1.0.0')).toThrow()
  })
  it.each(['1.0.1', '1.0.1-rc.1'])('manager.next %s 比当前新时换上', async (version) => {
    const f = await setup()
    await mkdir(join(f.home, 'manager.next'))
    await writeFile(join(f.home, 'manager.next/VERSION'), version)
    expect(await promoteManager(f.home)).toBe(true)
    expect(await readFile(join(f.home, 'manager/VERSION'), 'utf8')).toBe(version)
    await expect(readFile(join(f.home, 'manager.old/VERSION'))).rejects.toThrow()
  })
  it.each(['1.0.0', '0.9.0', '1.0.0-rc.1'])('manager.next %s 不更新', async (version) => {
    const f = await setup()
    await mkdir(join(f.home, 'manager.next'))
    await writeFile(join(f.home, 'manager.next/VERSION'), version)
    expect(await promoteManager(f.home)).toBe(false)
    expect(await readFile(join(f.home, 'manager/VERSION'), 'utf8')).toBe('1.0.0')
    expect(await readFile(join(f.home, 'manager.next/VERSION'), 'utf8')).toBe(version)
  })
  it.each(['first', 'second', 'cleanup'])('换管理进程的 %s 步失败时恢复原布局', async (failure) => {
    const f = await setup()
    await mkdir(join(f.home, 'manager.next'))
    await writeFile(join(f.home, 'manager.next/VERSION'), '1.1.0')
    let count = 0
    const fs = {
      readFile,
      rename: vi.fn<typeof rename>((from, to) => {
        count++
        if (count === (failure === 'first' ? 1 : failure === 'second' ? 2 : 99))
          return Promise.reject(Object.assign(new Error('occupied'), { code: 'EPERM' }))
        return rename(from, to)
      }),
      rm:
        failure === 'cleanup'
          ? vi.fn<typeof rm>(() => Promise.reject(Object.assign(new Error('occupied'), { code: 'EBUSY' })))
          : rm,
    }
    const log = vi.fn()
    expect(await promoteManager(f.home, { fs, log })).toBe(false)
    expect(await readFile(join(f.home, 'manager/VERSION'), 'utf8')).toBe('1.0.0')
    expect(await readFile(join(f.home, 'manager.next/VERSION'), 'utf8')).toBe('1.1.0')
    expect(log).toHaveBeenCalledWith(contains('继续使用旧版'))
  })
  it('off 模式根入口不换 manager.next，发行不完整时提示并退出 1', async () => {
    const f = await setup()
    await copyFile(new URL('../release/nextskin.mjs', import.meta.url), join(f.home, 'nextskin.mjs'))
    await mkdir(join(f.home, 'manager.next'))
    await writeFile(join(f.home, 'manager.next/VERSION'), '1.1.0')
    await writeFile(join(f.home, 'manager/main.mjs'), "console.log('loaded old manager')")
    const execute = promisify(execFile)
    expect(
      (
        await execute(process.execPath, [join(f.home, 'nextskin.mjs')], {
          env: { ...process.env, NEXTSKIN_MANAGER: 'off' },
        })
      ).stdout,
    ).toContain('loaded old manager')
    expect(await readFile(join(f.home, 'manager.next/VERSION'), 'utf8')).toBe('1.1.0')
    await rm(join(f.home, 'manager/main.mjs'))
    await expect(
      execute(process.execPath, [join(f.home, 'nextskin.mjs')], { env: { ...process.env, NEXTSKIN_MANAGER: 'off' } }),
    ).rejects.toMatchObject({ code: 1, stderr: contains('发行目录不完整') })
  })
})

describe('指针', () => {
  it('只接受合法完整的 schema，不能猜损坏指针', async () => {
    const f = await setup()
    for (const value of [
      null,
      {},
      { ...initialCurrent('1.0.0'), schema: 2 },
      { ...initialCurrent('1.0.0'), current: '../outside' },
      { ...initialCurrent('1.0.0'), failed: [2] },
      {
        ...initialCurrent('1.0.0'),
        upgrades: { '1.0.0': { from: '0.9.0', migrations: true, dialect: 'sqlite', backup: 'relative' } },
      },
    ])
      expect(() => parseCurrent(value)).toThrow()
    await writeFile(join(f.home, 'releases/current.json'), '{broken')
    await expect(readCurrent(f.home)).rejects.toMatchObject({ exitCode: 78 })
    await writeCurrent(f.home, initialCurrent('1.0.0'))
    expect(await readCurrent(f.home)).toEqual(initialCurrent('1.0.0'))
  })
  it('Windows 占用错误递增重试，非占用错误不重试', async () => {
    const delays: number[] = []
    const rename = vi
      .fn()
      .mockRejectedValueOnce({ code: 'EPERM' })
      .mockRejectedValueOnce({ code: 'EACCES' })
      .mockRejectedValueOnce({ code: 'EBUSY' })
      .mockResolvedValue(undefined)
    await renameRetry('from', 'to', {
      rename,
      sleep: (ms) => {
        delays.push(ms)
        return Promise.resolve()
      },
    })
    expect(delays).toEqual([100, 200, 300])
    expect(rename).toHaveBeenCalledTimes(4)
    const other = vi.fn().mockRejectedValue({ code: 'ENOENT' })
    await expect(renameRetry('a', 'b', { rename: other })).rejects.toEqual({ code: 'ENOENT' })
    expect(other).toHaveBeenCalledTimes(1)
  })
})

it('递归删除旧管理进程中途失败，仍从完整副本恢复', async () => {
  const f = await setup()
  await mkdir(join(f.home, 'manager.next'))
  await writeFile(join(f.home, 'manager.next/VERSION'), '1.1.0')
  await writeFile(join(f.home, 'manager/main.mjs'), 'old-manager')
  let removed = false
  const fs = {
    readFile,
    rename,
    rm: vi.fn<typeof rm>(async (path, options) => {
      if (String(path) === join(f.home, 'manager.old') && !removed) {
        removed = true
        await rm(join(f.home, 'manager.old/main.mjs'))
        throw Object.assign(new Error('partial'), { code: 'EBUSY' })
      }
      await rm(path, options)
    }),
  }
  expect(await promoteManager(f.home, { fs, log: vi.fn() })).toBe(false)
  expect(await readFile(join(f.home, 'manager/main.mjs'), 'utf8')).toBe('old-manager')
  expect(await readFile(join(f.home, 'manager.next/VERSION'), 'utf8')).toBe('1.1.0')
})

it('经符号链接运行根入口仍加载管理进程', async (context) => {
  const f = await setup()
  await copyFile(new URL('../release/nextskin.mjs', import.meta.url), join(f.home, 'nextskin.mjs'))
  await writeFile(join(f.home, 'manager/main.mjs'), "console.log('manager started')")
  const alias = join(f.home, 'alias')
  try {
    await symlink(f.home, alias, 'dir')
  } catch (error) {
    if (process.platform === 'win32') {
      context.skip()
      return
    }
    throw error
  }
  const child = spawn(process.execPath, [join(alias, 'nextskin.mjs')], {
    env: { ...process.env, NEXTSKIN_MANAGER: 'off' },
  })
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += String(chunk)
  })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('close', resolve)
    child.once('error', reject)
  })
  expect(code).toBe(0)
  expect(output).toContain('manager started')
})
