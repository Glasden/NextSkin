import { expect, test } from 'vitest'
import { ipcLogWriter, logLimitsFromMessage, logLineFromMessage, type IpcChannel } from './ipc.ts'

function channel() {
  const sent: unknown[] = []
  const callbacks: ((error: Error | null) => void)[] = []
  const value: { connected: boolean; send: IpcChannel['send'] } = {
    connected: true,
    send(message: unknown, callback: (error: Error | null) => void) {
      sent.push(message)
      callbacks.push(callback)
      return true
    },
  } satisfies IpcChannel
  return { value, sent, callbacks }
}

test('记录经 IPC 发出去；通道断开后改写 fallback', () => {
  const { value, sent } = channel()
  const fallback: string[] = []
  const write = ipcLogWriter(value, (line) => fallback.push(line))
  write('{"msg":"a"}')
  value.connected = false
  write('{"msg":"b"}')
  expect(sent).toEqual([{ nextskin: 'log', line: '{"msg":"a"}' }])
  expect(fallback).toEqual(['{"msg":"b"}'])
})

test('积压超过上限时丢掉新的；发得出去之后先补一条 warn 说丢了几条', () => {
  const { value, sent, callbacks } = channel()
  const write = ipcLogWriter(value, () => {}, 2)
  write('1')
  write('2')
  write('3')
  write('4')
  expect(sent).toHaveLength(2)
  callbacks[0]!(null)
  write('5')
  expect(sent).toHaveLength(4)
  const notice = JSON.parse((sent[2] as { line: string }).line) as Record<string, unknown>
  expect(notice).toEqual({
    time: expect.any(String) as unknown,
    level: 'warn',
    source: 'core',
    area: 'logging',
    msg: 'log_ipc_dropped',
    dropped: 2,
  })
  expect(sent[3]).toEqual({ nextskin: 'log', line: '5' })
})

test('send 同步抛错（通道正在关闭）时改写 fallback', () => {
  const fallback: string[] = []
  const write = ipcLogWriter(
    {
      connected: true,
      send: () => {
        throw new Error('ERR_IPC_CHANNEL_CLOSED')
      },
    },
    (line) => fallback.push(line),
  )
  write('x')
  expect(fallback).toEqual(['x'])
})

test('启动器只认这两种消息：一行记录、取值在范围里的轮换上限', () => {
  expect(logLineFromMessage({ nextskin: 'log', line: '{"msg":"a"}' })).toBe('{"msg":"a"}')
  expect(logLineFromMessage({ nextskin: 'log', line: 'a\nb' })).toBeNull()
  expect(logLineFromMessage({ nextskin: 'ready' })).toBeNull()
  expect(logLineFromMessage(null)).toBeNull()
  expect(logLimitsFromMessage({ nextskin: 'logConfig', maxFileSizeMb: 20, maxFiles: 3 })).toEqual({
    maxFileSizeMb: 20,
    maxFiles: 3,
  })
  expect(logLimitsFromMessage({ nextskin: 'logConfig', maxFileSizeMb: 20, maxFiles: 1 })).toBeNull()
  expect(logLimitsFromMessage({ nextskin: 'logConfig', maxFileSizeMb: 0.5, maxFiles: 3 })).toBeNull()
  expect(logLimitsFromMessage({ nextskin: 'log', maxFileSizeMb: 20, maxFiles: 3 })).toBeNull()
})
