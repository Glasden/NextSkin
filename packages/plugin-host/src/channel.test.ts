import { PassThrough, Writable } from 'node:stream'
import { serialize } from 'node:v8'
import { expect, test, vi } from 'vitest'
import { ChannelBackpressureError, ChannelClosedError, createFrameChannel, MAX_FRAME_BYTES } from './channel.ts'

function frame(message: unknown): Buffer {
  const body = serialize(message)
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}

test.each([new Error('处理失败'), '处理失败'])('消息回调抛出 %s 时关闭，异常不外泄且不交付后续帧', (error) => {
  const input = new PassThrough()
  const output = new PassThrough()
  const onMessage = vi.fn(() => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- 验证不可信的消息回调抛出非 Error 时也能关闭通道
    throw error
  })
  const onClose = vi.fn()
  const channel = createFrameChannel({ input, output, onMessage, onClose })
  expect(() => input.write(Buffer.concat([frame('first'), frame('second')]))).not.toThrow()
  expect(onMessage).toHaveBeenCalledExactlyOnceWith('first')
  // 抛出的不是 Error 时不把它的内容带进关闭原因：原因会写进日志
  expect(onClose).toHaveBeenCalledExactlyOnceWith(error instanceof Error ? error : new Error('处理消息时出错'))
  expect(channel.closed).toBe(true)
  expect(input.destroyed).toBe(true)
  expect(() => channel.send('later')).toThrow(ChannelClosedError)
  expect(output.writableLength).toBe(0)
})

test('写端积压达到上限仍可发送，超过上限后关闭且不再写入', () => {
  const input = new PassThrough()
  const output = new Writable({ highWaterMark: 1, write() {} })
  const onMessage = vi.fn()
  const onClose = vi.fn()
  const size = frame('test').length
  const channel = createFrameChannel({ input, output, maxPendingBytes: size, onMessage, onClose })
  channel.send('test')
  expect(channel.closed).toBe(false)
  expect(output.writableLength).toBe(size)
  expect(() => channel.send('test')).toThrow(ChannelClosedError)
  expect(onClose).toHaveBeenCalledExactlyOnceWith(expect.any(ChannelBackpressureError))
  expect(channel.closed).toBe(true)
  const pending = output.writableLength
  expect(() => channel.send('later')).toThrow(ChannelClosedError)
  expect(output.writableLength).toBe(pending)
  input.emit('data', frame('later'))
  expect(onMessage).not.toHaveBeenCalled()
  output.destroy()
})

test('发送前已超限时不再写入', () => {
  const input = new PassThrough()
  const output = new Writable({ write() {} })
  output.write(Buffer.alloc(11))
  const onClose = vi.fn()
  const channel = createFrameChannel({ input, output, maxPendingBytes: 10, onMessage() {}, onClose })
  expect(() => channel.send('test')).toThrow(ChannelClosedError)
  expect(output.writableLength).toBe(11)
  expect(onClose).toHaveBeenCalledExactlyOnceWith(expect.any(ChannelBackpressureError))
  output.destroy()
})

test('默认允许积压两倍最大帧字节数，超过后关闭', () => {
  const input = new PassThrough()
  const output = new Writable({ write() {} })
  output.write(Buffer.alloc(2 * MAX_FRAME_BYTES))
  const onClose = vi.fn()
  const channel = createFrameChannel({ input, output, onMessage() {}, onClose })
  expect(() => channel.send(null)).toThrow(ChannelClosedError)
  expect(output.writableLength).toBe(2 * MAX_FRAME_BYTES + frame(null).length)
  expect(onClose).toHaveBeenCalledExactlyOnceWith(expect.any(ChannelBackpressureError))
  output.destroy()
})

test('写端持续消费时能连续发送，读端能接收分片和连续帧', () => {
  const input = new PassThrough()
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })
  const onMessage = vi.fn()
  const onClose = vi.fn()
  const channel = createFrameChannel({ input, output, maxPendingBytes: 1, onMessage, onClose })
  channel.send('first')
  channel.send('second')
  const bytes = Buffer.concat([frame('first'), frame('second')])
  input.write(bytes.subarray(0, 2))
  input.write(bytes.subarray(2))
  expect(onMessage.mock.calls).toEqual([['first'], ['second']])
  expect(onClose).not.toHaveBeenCalled()
  input.destroy()
  output.destroy()
})
