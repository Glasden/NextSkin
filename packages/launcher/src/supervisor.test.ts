import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
async function run(plan: object[]) {
  const dir = await mkdtemp(join(tmpdir(), 'launcher-supervisor-'))
  const state = join(dir, 'runs')
  const child = fork(fileURLToPath(new URL('./fixtures/supervisor.ts', import.meta.url)), [], {
    execArgv: [],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, LAUNCHER_TEST_STATE: state, LAUNCHER_TEST_PLAN: JSON.stringify(plan) },
  })
  const messages: { log: string; time: number }[] = []
  child.on('message', (message: { log: string; time: number }) => {
    messages.push(message)
  })
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit')
      child.kill('SIGTERM')
      await exit
    }
    await rm(dir, { recursive: true, force: true })
  })
  return { child, messages, state }
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
  expect(messages.every((m) => m.log.startsWith('[nextskin]'))).toBe(true)
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
