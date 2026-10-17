import { BlockList, isIP } from 'node:net'

function normalizeAddress(value: string): string | null {
  const address = value.split('%')[0]!.toLowerCase()
  if (!isIP(address) || (value.includes('%') && isIP(address) !== 6)) return null
  if (isIP(address) === 4) return address
  // URL 的 IPv6 序列化同时收敛展开形式和十六进制的 IPv4 映射地址。
  const canonical = new URL(`http://[${address}]`).hostname.slice(1, -1)
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical)
  if (!mapped) return canonical
  const high = Number.parseInt(mapped[1]!, 16)
  const low = Number.parseInt(mapped[2]!, 16)
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`
}

/** 设置校验与解析器共用 BlockList 的 IP/CIDR 解析，不自行计算网段。 */
function addProxy(list: BlockList, value: string): boolean {
  const parts = value.split('/')
  const address = parts[0]!
  const version = isIP(address)
  if (!version || parts.length > 2) return false
  const family = version === 4 ? 'ipv4' : 'ipv6'
  try {
    if (parts.length === 1) list.addAddress(address, family)
    else {
      if (!/^\d+$/.test(parts[1]!)) return false
      list.addSubnet(address, Number(parts[1]), family)
    }
    return true
  } catch {
    return false
  }
}

export function isTrustedProxy(value: string): boolean {
  return addProxy(new BlockList(), value)
}

export function resolveClientIp(input: {
  forwardedFor: string | null
  peer: string | null
  trustedProxies: readonly string[]
}): string | null {
  if (input.peer === null) return null
  let current = normalizeAddress(input.peer)
  if (!current) return null
  const trusted = new BlockList()
  for (const proxy of input.trustedProxies) {
    if (!addProxy(trusted, proxy)) throw new TypeError('invalid trusted proxy')
  }
  const chain = input.forwardedFor === null ? [] : input.forwardedFor.split(',').map((part) => part.trim())
  for (let index = chain.length - 1; index >= 0; index--) {
    if (!trusted.check(current, isIP(current) === 4 ? 'ipv4' : 'ipv6')) break
    const next = normalizeAddress(chain[index]!)
    if (!next) break
    current = next
  }
  return current
}
