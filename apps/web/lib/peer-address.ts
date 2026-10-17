// Next 对 X-Forwarded-For 使用 ??=，客户端自带该头时会丢失 socket 对端。
// ADR-0003 不用自定义服务器，改在 request.start 同步覆盖内部头。instrumentation 可能在监听后才订阅，
// 启动竞态中的请求仍可能带伪造头；进程内随机串确保这种请求被当作对端未知。
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { subscribe } from 'node:diagnostics_channel'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'

const holder = globalThis as typeof globalThis & {
  nextskinPeerSecret?: string
  nextskinPeerSubscribed?: boolean
}

function secret(): string {
  return (holder.nextskinPeerSecret ??= randomBytes(32).toString('hex'))
}

export function subscribePeerAddress(): void {
  secret()
  if (holder.nextskinPeerSubscribed) return
  subscribe('http.server.request.start', (message) => {
    const { request, socket } = message as { request: IncomingMessage; socket: Socket }
    if (socket.remoteAddress) request.headers['x-nextskin-peer'] = `${secret()} ${socket.remoteAddress}`
    else delete request.headers['x-nextskin-peer']
  })
  holder.nextskinPeerSubscribed = true
}

export function peerAddress(headers: Headers): string | null {
  const value = headers.get('x-nextskin-peer')
  if (!value) return null
  const separator = value.indexOf(' ')
  if (separator < 0) return null
  const received = Buffer.from(value.slice(0, separator))
  const expected = Buffer.from(secret())
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null
  return value.slice(separator + 1) || null
}
