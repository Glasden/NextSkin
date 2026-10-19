/**
 * 核心和 plugin host 之间的消息通道：host 的 stdin/stdout 上，每条消息是 4 字节大端长度加 v8 序列化的内容。
 *
 * 不用 Node 自带的 IPC：它收消息时按对方声明的长度整块缓冲，解码之前没法限制大小，host 可以让核心占满内存
 * （S5 遗留风险第 5 条）。这里读到长度头就检查，超过上限立即关掉通道，不再读后面的数据。
 * 也不用额外的 fd：Node 26 的权限模型把在额外的 fd 上建 socket 当成网络操作拦掉，stdin/stdout 不受影响。
 * v8 序列化能传 Uint8Array 和 bigint（插件查询的 numAffectedRows），JSON 不能。
 */
import type { Readable, Writable } from 'node:stream'
import { deserialize, serialize } from 'node:v8'

/** 单条消息的上限：插件路由的请求体、响应体最大 10 MiB，留出余量 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024
const HEADER_BYTES = 4

export class FrameTooLargeError extends Error {
  override name = 'FrameTooLargeError'
  constructor(size: number, max: number) {
    super(`消息有 ${size} 字节，超过了 ${max} 字节的上限`)
  }
}

export class ChannelClosedError extends Error {
  override name = 'ChannelClosedError'
  constructor() {
    super('通道已经关闭')
  }
}

export class ChannelBackpressureError extends Error {
  override name = 'ChannelBackpressureError'
  constructor() {
    super('通道待发送的数据超过上限')
  }
}

export interface FrameChannel<Out> {
  /** 单帧超限时抛 FrameTooLargeError，不发送；积压超限时关闭通道并抛 ChannelClosedError，关闭后不再发送 */
  send(message: Out): void
  /** 结束写端：对面读到结束就知道这边不再发了 */
  end(): void
  readonly closed: boolean
}

/**
 * 在一对流上收发消息。读端出错、读到结束、收到超长或解不开的消息时调用一次 `onClose`，之后不再交付消息。
 * 消息的内容由调用方检查：对面可能完全不可信
 */
export function createFrameChannel<In, Out>(options: {
  input: Readable
  output: Writable
  maxFrameBytes?: number
  maxPendingBytes?: number
  onMessage(message: In): void
  onClose(error?: Error): void
}): FrameChannel<Out> {
  const max = options.maxFrameBytes ?? MAX_FRAME_BYTES
  const maxPending = options.maxPendingBytes ?? 2 * MAX_FRAME_BYTES
  const chunks: Buffer[] = []
  let buffered = 0
  let closed = false

  function close(error?: Error) {
    if (closed) return
    closed = true
    chunks.length = 0
    buffered = 0
    options.input.off('data', onData)
    options.input.destroy()
    options.onClose(error)
  }

  /** 从缓冲区头部取出 size 字节 */
  function take(size: number): Buffer {
    const all = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, buffered)
    const head = all.subarray(0, size)
    const rest = all.subarray(size)
    chunks.length = 0
    if (rest.length) chunks.push(rest)
    buffered = rest.length
    return head
  }

  function peekLength(): number {
    if (chunks[0]!.length >= HEADER_BYTES) return chunks[0]!.readUInt32BE(0)
    return Buffer.concat(chunks, buffered).readUInt32BE(0)
  }

  function onData(chunk: Buffer) {
    if (closed) return
    chunks.push(chunk)
    buffered += chunk.length
    while (!closed && buffered >= HEADER_BYTES) {
      const size = peekLength()
      if (size > max) return close(new FrameTooLargeError(size, max))
      if (buffered < HEADER_BYTES + size) return
      const frame = take(HEADER_BYTES + size).subarray(HEADER_BYTES)
      let message: In
      try {
        message = deserialize(frame) as In
      } catch {
        return close(new Error('收到了解不开的消息'))
      }
      try {
        options.onMessage(message)
      } catch (error) {
        // 抛出来的可能是对面构造的任意值，转字符串也可能再抛：不碰它
        return close(error instanceof Error ? error : new Error('处理消息时出错'))
      }
    }
  }

  options.input.on('data', onData)
  options.input.on('end', () => close())
  options.input.on('error', (error: Error) => close(error))
  // 对面先退出时写端会报 EPIPE；读端随后也会结束，由读端统一收尾
  options.output.on('error', () => {})

  return {
    send(message) {
      if (closed) throw new ChannelClosedError()
      if (options.output.writableLength > maxPending) {
        close(new ChannelBackpressureError())
        throw new ChannelClosedError()
      }
      const body = serialize(message)
      if (body.length > max) throw new FrameTooLargeError(body.length, max)
      const header = Buffer.allocUnsafe(HEADER_BYTES)
      header.writeUInt32BE(body.length, 0)
      options.output.write(Buffer.concat([header, body]))
      if (options.output.writableLength > maxPending) {
        close(new ChannelBackpressureError())
        throw new ChannelClosedError()
      }
    },
    end() {
      options.output.end()
    },
    get closed() {
      return closed
    },
  }
}
