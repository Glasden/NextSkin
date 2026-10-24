import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { createManagerClient, managerErrorCodes, type ManagerStatus, type ManagerParams } from './manager-client.ts'

const token = 'abcdef01'.repeat(8)
const status: ManagerStatus = {
  protocol: 1,
  version: '0.4.0',
  current: '0.4.0',
  previous: '0.3.0',
  writable: true,
  operation: {
    kind: 'prepare',
    version: '0.5.0',
    step: 'download',
    startedAt: '2026-10-23T00:00:00.000Z',
    progress: { received: 10, total: 100 },
  },
  prepared: {
    version: '0.5.0',
    preflight: {
      dialect: 'postgres',
      pendingCore: 1,
      pendingPlugins: 2,
      tier: 'external-backup',
      incompatiblePlugins: [{ id: 'test', api: '^1.0' }],
    },
  },
  lastResult: {
    at: '2026-10-23T00:00:00.000Z',
    kind: 'update',
    from: '0.3.0',
    to: '0.4.0',
    result: 'success',
    step: null,
    reason: null,
  },
  failed: ['0.4.1'],
  rollback: { version: '0.3.0', migrations: true, dialect: 'sqlite', backupAvailable: true },
}
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
async function server(reply: (socket: Socket, request: unknown) => void) {
  const directory = await mkdtemp(join(tmpdir(), 'nsm-'))
  // Windows 上 net 只能监听命名管道，和管理进程的控制通道一样
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\${basename(directory)}` : join(directory, 's')
  const sockets = new Set<Socket>()
  const requests: unknown[] = []
  const listener = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    let line = ''
    socket.on('data', (data) => {
      line += data.toString()
      if (!line.endsWith('\n')) return
      const request: unknown = JSON.parse(line)
      requests.push(request)
      reply(socket, request)
    })
  })
  await new Promise<void>((resolve, reject) => listener.once('error', reject).listen(address, resolve))
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())))
    await rm(directory, { recursive: true, force: true })
  })
  return { client: createManagerClient({ address, token }), requests, sockets }
}
function fake(reply?: unknown, connected = true) {
  const socket = new Socket()
  const write = vi.spyOn(socket, 'write').mockImplementation(() => {
    if (reply !== undefined) queueMicrotask(() => socket.emit('data', Buffer.from(JSON.stringify(reply) + '\n')))
    return true
  })
  const connect = vi.fn(() => {
    if (connected) queueMicrotask(() => socket.emit('connect'))
    return socket
  })
  return { client: createManagerClient({ address: 'unused', token, connect }), socket, connect, write }
}

test('临时 socket 正常往返，每次新建连接，令牌只在请求体内', async () => {
  const { client, requests } = await server((socket) => socket.end(JSON.stringify({ ok: true, result: status }) + '\n'))
  expect(await client.request('status', {})).toEqual(status)
  expect(await client.request('status', {})).toEqual(status)
  expect(requests).toEqual(Array.from({ length: 2 }, () => ({ token, method: 'status', params: {} })))
})
test.each(['prepare', 'apply', 'rollback', 'cancel'] as const)('%s 校验各自的确认结果', async (method) => {
  const result = method === 'cancel' ? { cancelled: false } : { accepted: true }
  const { client, write } = fake({ ok: true, result })
  const params: ManagerParams[typeof method] =
    method === 'apply'
      ? { version: '0.5.0', backupConfirmed: true }
      : method === 'prepare'
        ? { version: '0.5.0' }
        : method === 'rollback'
          ? { confirmed: true }
          : {}
  expect(await client.request(method, params)).toEqual(result)
  expect(write).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ token, method, params }) + '\n')
})
test('连不上以及连接函数同步抛错都不暴露底层异常', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nsm-'))
  try {
    await expect(
      createManagerClient({ address: join(directory, 'missing'), token }).request('status', {}),
    ).rejects.toMatchObject({ code: 'update_unreachable' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
  const client = createManagerClient({
    address: 'unused',
    token,
    connect: () => {
      throw new Error(token)
    },
  })
  await expect(client.request('status', {})).rejects.toMatchObject({
    code: 'update_unreachable',
    message: 'update_unreachable',
  })
})
test.each([false, true])('连接或读响应超时（已连接：%s）销毁连接', async (connected) => {
  vi.useFakeTimers()
  const { client, socket, write } = fake(undefined, connected)
  const assertion = expect(client.request('status', {})).rejects.toMatchObject({ code: 'update_unreachable' })
  await vi.advanceTimersByTimeAsync(connected ? 10_000 : 3_000)
  await assertion
  expect(socket.destroyed).toBe(true)
  expect(write).toHaveBeenCalledTimes(connected ? 1 : 0)
})
test.each([
  ['半行', '{"ok":true'],
  ['没有换行的完整 JSON', '{"ok":true,"result":{}}'],
  ['超长行', '中'.repeat(22_000) + '\n'],
  ['非法 JSON', '{invalid}\n'],
  ['多行', '{}\n{}\n'],
])('%s 视为 unreachable', async (_, reply) => {
  const { client } = await server((socket) => socket.end(reply))
  await expect(client.request('status', {})).rejects.toMatchObject({ code: 'update_unreachable' })
})
test('UTF-8 字符跨 chunk 时按字节拼接', async () => {
  const { client, socket, write } = fake()
  write.mockImplementation(() => {
    const line = Buffer.from(JSON.stringify({ ok: false, error: { code: 'busy', message: '正在准备' } }) + '\n')
    const split = line.indexOf(Buffer.from('正')) + 1
    queueMicrotask(() => {
      socket.emit('data', line.subarray(0, split))
      socket.emit('data', line.subarray(split))
    })
    return true
  })
  await expect(client.request('prepare', { version: '0.5.0' })).rejects.toMatchObject({
    code: 'update_busy',
    params: { message: '正在准备' },
  })
})
test('超长请求不连接，不把令牌放进异常', async () => {
  const { client, connect } = fake()
  await expect(client.request('prepare', { version: 'x'.repeat(64 * 1024) })).rejects.toMatchObject({
    code: 'update_unreachable',
  })
  expect(connect).not.toHaveBeenCalled()
})
test.each(managerErrorCodes)('ok:false 的 %s 添加领域前缀并保留具体消息', async (code) => {
  const { client } = fake({ ok: false, error: { code, message: '具体原因' } })
  await expect(client.request('prepare', { version: '0.5.0' })).rejects.toMatchObject({
    code: `update_${code}`,
    params: { message: '具体原因' },
  })
})
test('未知错误码归 update_internal；反射的令牌被移除，消息按字符截断到 500，任何日志不含令牌', async () => {
  const logs = ['log', 'info', 'warn', 'error', 'debug'].map((key) =>
    vi.spyOn(console, key as 'log').mockImplementation(() => {}),
  )
  const { client } = fake({ ok: false, error: { code: token, message: token + '原因😀'.repeat(200) } })
  const error: unknown = await client.request('status', {}).catch((cause: unknown) => cause)
  expect(error).toMatchObject({ code: 'update_internal' })
  const domain = error as { params: { message: string }; stack: string }
  expect(Array.from(domain.params.message)).toHaveLength(500)
  expect([String(error), domain.stack, JSON.stringify(error)].join()).not.toContain(token)
  expect(logs.flatMap((spy) => spy.mock.calls)).toEqual([])
})
test.each([
  { ...status, protocol: undefined },
  { ...status, writable: 'true' },
  { ...status, prepared: { version: '0.5.0', preflight: {} } },
  { ...status, operation: { ...status.operation, startedAt: 'yesterday' } },
  { ...status, rollback: { ...status.rollback, dialect: 'postgresql' } },
])('status 缺字段或类型错误不接受 %#', async (result) => {
  const { client } = fake({ ok: true, result })
  await expect(client.request('status', {})).rejects.toMatchObject({ code: 'update_unreachable' })
})
test('status 多字段接受并忽略，包括嵌套字段', async () => {
  const { client } = fake({
    ok: true,
    extra: true,
    result: { ...status, future: 1, operation: { ...status.operation, future: 2 } },
  })
  expect(await client.request('status', {})).toEqual(status)
})
test.each([
  { ok: true, result: { accepted: false } },
  { ok: true },
  { ok: false, error: { code: 'busy' } },
  { ok: 'true', result: { accepted: true } },
])('非法信封或成功结果不能当作接受 %#', async (response) => {
  await expect(
    fake(response).client.request('apply', { version: '0.5.0', backupConfirmed: false }),
  ).rejects.toMatchObject({ code: 'update_unreachable' })
})

test.each([undefined, null, '0.5.0'])('status 兼容旧管理进程缺省的 pendingManager：%j', async (pendingManager) => {
  const result = { ...status, ...(pendingManager === undefined ? {} : { pendingManager }) }
  const { client } = fake({ ok: true, result })
  expect(await client.request('status', {})).toEqual(result)
})
