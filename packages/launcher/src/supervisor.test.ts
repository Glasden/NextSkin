import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { removeTestDirectory } from '@nextskin/db/testing'
import { parseLogRecord, type LogRecord } from '@nextskin/logging'
import { afterEach, expect, test, vi } from 'vitest'
import { createLauncherOutput } from './output.ts'
import { supervise } from './supervisor.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
interface Message {
  log: string
  record: LogRecord | null
  time: number
}
async function run(plan: object[], env: NodeJS.ProcessEnv = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'launcher-supervisor-'))
  const state = join(dir, 'runs')
  const child = fork(fileURLToPath(new URL('./fixtures/supervisor.ts', import.meta.url)), [], {
    execArgv: [],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, LAUNCHER_TEST_STATE: state, LAUNCHER_TEST_PLAN: JSON.stringify(plan), ...env },
  })
  const messages: Message[] = []
  child.on('message', (message: Message) => {
    messages.push(message)
  })
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit')
      child.kill('SIGTERM')
      await exit
    }
    await removeTestDirectory(dir)
  })
  return { child, messages, state, dir }
}
function signal(child: ChildProcess, name: NodeJS.Signals) {
  if (process.platform === 'win32') child.send({ signal: name })
  else child.kill(name)
}
async function stop(child: ChildProcess, name: NodeJS.Signals = 'SIGTERM') {
  const exit = once(child, 'exit')
  signal(child, name)
  return (await exit) as [number | null, NodeJS.Signals | null]
}

test('崩溃按退避重启，ready 后稳定运行重置退避，未知消息不算 ready', async () => {
  const { child, messages } = await run([
    { exitAfter: 5 },
    { exitAfter: 5 },
    { exitAfter: 5 },
    { exitAfter: 5 },
    { ready: true, exitAfter: 350 },
    { ready: true },
  ])
  await expect.poll(() => messages.filter((m) => m.log.includes('核心已启动')).length, { timeout: 5000 }).toBe(2)
  expect(messages.filter((m) => m.log.includes('后重启')).map((m) => m.log.match(/，(\d+) 毫秒/)?.[1])).toEqual([
    '20',
    '40',
    '80',
    '80',
    '20',
  ])
  const crashes = messages.filter((m) => m.log.includes('后重启'))
  for (let index = 1; index < crashes.length; index++) {
    const previous = crashes[index - 1]!
    const delay = Number(previous.log.match(/，(\d+) 毫秒/)![1])
    expect(crashes[index]!.time - previous.time).toBeGreaterThanOrEqual(delay - 1)
  }
  expect(messages.every((m) => m.record?.source === 'launcher')).toBe(true)
  expect(messages.find((m) => m.log.includes('后重启'))?.record?.level).toBe('warn')
  expect(await stop(child)).toEqual([0, null])
})

test('停止时发送 shutdown，等待核心完成退出', async () => {
  const { child, messages, state } = await run([{ ready: true, stopAfter: 40 }])
  await expect.poll(() => messages.length, { timeout: 5000 }).toBe(1)
  const start = Date.now()
  expect(await stop(child)).toEqual([0, null])
  expect(Date.now() - start).toBeGreaterThanOrEqual(35)
  expect(await readFile(state + '.events', 'utf8')).toBe('shutdown\n')
  expect(await readFile(state, 'utf8')).toBe('1')
})

test('无视 shutdown 时到时强杀；停止中的第二次 SIGINT 立即强杀', async () => {
  for (const twice of [false, true]) {
    const { child, messages, state } = await run([{ ready: true, ignoreShutdown: true }])
    await expect.poll(() => messages.length, { timeout: 5000 }).toBe(1)
    const exit = once(child, 'exit')
    const start = Date.now()
    signal(child, 'SIGINT')
    await expect.poll(() => messages.some((m) => m.log.includes('正在停止')), { timeout: 5000 }).toBe(true)
    if (twice) signal(child, 'SIGINT')
    expect(await exit).toEqual([0, null])
    if (!twice) expect(Date.now() - start).toBeGreaterThanOrEqual(95)
    expect(await readFile(state + '.events', 'utf8')).toBe('shutdown\n')
  }
})

test('退避等待期间停止不再重启', async () => {
  const { child, messages, state } = await run([{ exitAfter: 5 }])
  await new Promise<void>((resolve) => {
    child.on('message', (message: { log: string }) => {
      if (message.log.includes('后重启')) resolve()
    })
  })
  expect(await stop(child)).toEqual([0, null])
  expect(await readFile(state, 'utf8')).toBe('1')
  expect(messages.filter((m) => m.log.includes('核心已启动'))).toHaveLength(0)
})

test('注册额外停止来源时已收到停止请求，不拉起核心且收回全部监听器', async () => {
  const before = process.listenerCount('SIGTERM')
  const dispose = vi.fn()
  const ready = vi.fn()
  expect(
    await supervise({
      serverJs: '/must-not-start/server.js',
      env: {},
      onReady: ready,
      stopOn: (stop) => {
        stop()
        return dispose
      },
    }),
  ).toBe(0)
  expect(dispose).toHaveBeenCalledOnce()
  expect(ready).not.toHaveBeenCalled()
  expect(process.listenerCount('SIGTERM')).toBe(before)
})

test('退避期间的额外停止来源取消重启，并且只注销一次', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'launcher-supervisor-'))
  cleanups.push(() => removeTestDirectory(dir))
  const state = join(dir, 'runs')
  const before = process.listenerCount('SIGTERM')
  const dispose = vi.fn()
  let stop: () => void = () => {}
  let crashed: () => void = () => {}
  const crash = new Promise<void>((resolve) => {
    crashed = resolve
  })
  const supervised = supervise({
    serverJs: fileURLToPath(new URL('./fixtures/core.mjs', import.meta.url)),
    env: { ...process.env, LAUNCHER_TEST_STATE: state, LAUNCHER_TEST_PLAN: JSON.stringify([{ exitAfter: 5 }]) },
    initialDelay: 60_000,
    stopOn: (requestStop) => {
      stop = requestStop
      return dispose
    },
    output: createLauncherOutput({}, (line) => {
      if (line.includes('后重启')) crashed()
    }),
  })
  await crash
  stop()
  expect(await supervised).toBe(0)
  expect(dispose).toHaveBeenCalledOnce()
  expect(await readFile(state, 'utf8')).toBe('1')
  expect(process.listenerCount('SIGTERM')).toBe(before)
})

test('核心经 IPC 发来的记录原样写出，带换行的不认；stdout、stderr 逐行记成原始输出，像记录的行也一样', async () => {
  const { child, messages } = await run([{ ready: true, print: true }], { LAUNCHER_TEST_FORWARD_RAW: '1' })
  await expect.poll(() => messages.some((m) => m.log === 'stderr 0'), { timeout: 5000 }).toBe(true)
  await expect.poll(() => messages.some((m) => m.log === 'stdout 0'), { timeout: 5000 }).toBe(true)
  const core = messages.map((m) => m.record).filter((record) => record?.source === 'core')
  expect(core.filter((record) => record?.msg === 'run 0')).toEqual([
    { time: expect.any(String) as unknown, level: 'info', source: 'core', area: 'test', msg: 'run 0' },
  ])
  expect(core.filter((record) => record?.raw)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ level: 'info', raw: true, msg: expect.stringContaining('"msg":"forged"') as unknown }),
      expect.objectContaining({ level: 'info', raw: true, msg: 'stdout 0' }),
      expect.objectContaining({ level: 'warn', raw: true, msg: 'stderr 0' }),
    ]),
  )
  expect(core.some((record) => record?.msg === 'forged')).toBe(false)
  expect(await stop(child)).toEqual([0, null])
})

test('核心崩溃重启时日志文件接着写', async () => {
  const data = await mkdtemp(join(tmpdir(), 'launcher-supervisor-data-'))
  cleanups.push(() => removeTestDirectory(data))
  const { child, messages } = await run(
    [
      { print: true, exitAfter: 30 },
      { ready: true, print: true },
    ],
    {
      LAUNCHER_TEST_DATA_DIR: data,
    },
  )
  await expect.poll(() => messages.some((m) => m.log === '核心已启动'), { timeout: 5000 }).toBe(true)
  await expect.poll(() => messages.some((m) => m.log === 'run 1'), { timeout: 5000 }).toBe(true)
  expect(await stop(child)).toEqual([0, null])
  const records = (await readFile(join(data, 'logs/nextskin.log'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => parseLogRecord(line))
  expect(records.every(Boolean)).toBe(true)
  const messagesInFile = records.map((record) => record!.msg)
  for (const expected of ['run 0', 'stdout 0', 'stderr 0', 'run 1', 'stdout 1', '核心已启动', '正在停止核心'])
    expect(messagesInFile).toContain(expected)
  expect(messagesInFile.some((msg) => msg.includes('后重启'))).toBe(true)
  expect(messagesInFile.indexOf('run 0')).toBeLessThan(messagesInFile.indexOf('run 1'))
})

test('核心一下子写很多时及时读走管道，不拖住核心；写盘跟不上就丢掉，丢了几条记在文件里', async () => {
  const data = await mkdtemp(join(tmpdir(), 'launcher-supervisor-data-'))
  cleanups.push(() => removeTestDirectory(data))
  const total = 8000
  const { child, messages } = await run([{ ready: true, burst: total }], { LAUNCHER_TEST_DATA_DIR: data })
  await expect.poll(() => messages.some((m) => m.log === '核心已启动'), { timeout: 20_000 }).toBe(true)
  expect(await stop(child)).toEqual([0, null])
  const lines: string[] = []
  for (const name of await readdir(join(data, 'logs')))
    lines.push(...(await readFile(join(data, 'logs', name), 'utf8')).split('\n').filter(Boolean))
  const records = lines.map((line) => parseLogRecord(line)!)
  const written = records.filter((record) => record.raw && record.msg.startsWith('burst ')).length
  const dropped = records
    .filter((record) => record.msg === '有记录没写进日志文件')
    .reduce((sum, record) => sum + (record.dropped as number), 0)
  expect(written + dropped).toBe(total)
}, 30_000)
