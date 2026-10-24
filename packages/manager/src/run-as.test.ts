import { createMemoryLogger } from '@nextskin/logging'
import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertDataOwner, logRunAs, resolveRunAs } from './run-as.ts'

function options(name: string, own = 0, uid = 1234, gid = 5678) {
  return {
    env: { NEXTSKIN_RUN_AS: name },
    platform: 'linux' as const,
    getuid: () => own,
    execFileSync: vi.fn<typeof execFileSync>().mockReturnValueOnce(`${uid}\n`).mockReturnValueOnce(`${gid}\n`),
  }
}

describe('NEXTSKIN_RUN_AS 的 NSS 解析', () => {
  it.each(['nextskin', '_', 'service_2', 'Service-2', 'account$', 'a'.repeat(32) + '$'])('接受用户名 %s', (name) => {
    const input = options(name)
    expect(resolveRunAs(input)).toEqual({ name, uid: 1234, gid: 5678 })
    expect(input.execFileSync.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ['id', ['-u', name]],
      ['id', ['-g', name]],
    ])
  })
  it.each(['', 'a'.repeat(33), '1user', '-u', 'a b', 'a.b', 'a;id', 'a\n', 'a$$', 'a/b'])(
    '拒绝用户名 %j，且不运行 id',
    (name) => {
      const input = options(name)
      expect(() => resolveRunAs(input)).toThrow(expect.objectContaining({ exitCode: 78 }))
      expect(input.execFileSync).not.toHaveBeenCalled()
    },
  )
  it('不设置时不解析；目标是自己时不指定 uid/gid', () => {
    const execute = vi.fn<typeof execFileSync>()
    expect(resolveRunAs({ env: {}, execFileSync: execute })).toBeUndefined()
    expect(execute).not.toHaveBeenCalled()
    expect(resolveRunAs(options('self', 1000, 1000, 2000))).toBeUndefined()
  })
  it('Windows 拒绝设置，非 root 不能切换到其他 uid', () => {
    const input = options('nextskin')
    expect(() => resolveRunAs({ ...input, platform: 'win32' })).toThrow(expect.objectContaining({ exitCode: 78 }))
    expect(input.execFileSync).not.toHaveBeenCalled()
    expect(() => resolveRunAs(options('nextskin', 1000))).toThrow('降权要以 root 运行管理进程')
  })
  it.each([0, 1])('id 的第 %i 次调用失败是配置错误，不透出异常内容', (failedCall) => {
    const input = options('nextskin')
    input.execFileSync.mockReset()
    if (failedCall === 1) input.execFileSync.mockReturnValueOnce('1234\n')
    input.execFileSync.mockImplementationOnce(() => {
      throw new Error('private diagnostic')
    })
    expect(() => resolveRunAs(input)).toThrow('无法通过 id 解析')
  })
  it.each(['', '-1', '1x', '1.5', '4294967295', '9007199254740992', '2\n3'])('拒绝不合法的 id 输出 %j', (value) => {
    const input = options('nextskin')
    input.execFileSync.mockReset().mockReturnValue(value)
    expect(() => resolveRunAs(input)).toThrow(expect.objectContaining({ exitCode: 78 }))
  })
  it('只打印服务用户身份，不打印环境', () => {
    const { logger, records } = createMemoryLogger({ source: 'manager' })
    logRunAs({ name: 'nextskin', uid: 1234, gid: 5678 }, logger)
    expect(records).toHaveLength(1)
    expect(records).toMatchObject([{ level: 'info', msg: '以 nextskin（1234/5678）运行服务' }])
    logRunAs(undefined, logger)
    expect(records).toHaveLength(1)
  })
})

it('root 的数据归属保护：服务用户、root 数据和缺失路径可通过，未降权不得写他人的数据', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nextskin-owner-'))
  try {
    const info = await stat(directory)
    info.uid = 1234
    const inspect = vi.fn(() => Promise.resolve(info))
    await expect(assertDataOwner(directory, { getuid: () => 0, stat: inspect })).rejects.toMatchObject({ exitCode: 78 })
    await expect(assertDataOwner(directory, { getuid: () => 0, stat: inspect })).rejects.toThrow(
      '数据目录属于 uid 1234',
    )
    await assertDataOwner(directory, { getuid: () => 1000, stat: inspect })
    await assertDataOwner(directory, {
      getuid: () => 0,
      runAs: { name: 'service', uid: 1234, gid: 5678 },
      stat: inspect,
    })
    info.uid = 0
    await assertDataOwner(directory, { getuid: () => 0, stat: inspect })
    await assertDataOwner(join(directory, 'missing'), { getuid: () => 0 })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
