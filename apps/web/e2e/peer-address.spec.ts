import { channel } from 'node:diagnostics_channel'
import { expect, test } from './fixtures'
import { peerAddress, subscribePeerAddress } from '../lib/peer-address'

test('订阅前和签名不匹配的内部头不可信；同步订阅覆盖伪造头且可重复调用', () => {
  expect(peerAddress(new Headers())).toBeNull()
  expect(peerAddress(new Headers({ 'x-nextskin-peer': 'forged 203.0.113.1' }))).toBeNull()
  expect(peerAddress(new Headers({ 'x-nextskin-peer': `${'0'.repeat(64)} 203.0.113.1` }))).toBeNull()
  subscribePeerAddress()
  subscribePeerAddress()
  const request = { headers: { 'x-nextskin-peer': 'forged 203.0.113.1' } }
  channel('http.server.request.start').publish({ request, socket: { remoteAddress: '::ffff:127.0.0.1' } })
  expect(peerAddress(new Headers(request.headers))).toBe('::ffff:127.0.0.1')
  channel('http.server.request.start').publish({ request, socket: {} })
  expect(request.headers).not.toHaveProperty('x-nextskin-peer')
})
