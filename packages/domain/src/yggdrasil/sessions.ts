import { isIP } from 'node:net'

export interface JoinSession {
  pid: number
  uuid: string
  ip: string | null
}

export interface YggdrasilSessionCache {
  get(serverId: string): Promise<JoinSession | null>
  set(serverId: string, value: JoinSession, ttlMs: number): Promise<void>
}

/** The game server id is only unique inside one API route; isolate route contexts. */
export function sessionCacheKey(serverId: string, serverKey: string | null): string {
  return `${serverKey ?? ''}\u0000${serverId}`
}

export function createMemorySessionCache(now: () => Date): YggdrasilSessionCache {
  const entries = new Map<string, { value: JoinSession; expiresAt: number }>()
  return {
    get(serverId) {
      const entry = entries.get(serverId)
      return Promise.resolve(entry && entry.expiresAt > now().getTime() ? { ...entry.value } : null)
    },
    set(serverId, value, ttlMs) {
      const time = now().getTime()
      for (const [key, entry] of entries) if (entry.expiresAt <= time) entries.delete(key)
      entries.set(serverId, { value: { ...value }, expiresAt: time + ttlMs })
      return Promise.resolve()
    },
  }
}

/**
 * 同一个地址的不同写法统一成一种：IPv6 压缩成规范写法，IPv4 映射地址（`::ffff:1.2.3.4`、
 * `0:0:0:0:0:ffff:1.2.3.4`、`::ffff:102:304`）换成 IPv4。非法字符串原样返回
 */
export function normalizeIp(ip: string | null): string | null {
  if (ip === null || isIP(ip) !== 6) return ip
  let canonical: string
  try {
    canonical = new URL(`http://[${ip}]`).hostname.slice(1, -1)
  } catch {
    return ip
  }
  // URL 把映射地址的 IPv4 部分也写成十六进制
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical)
  if (!mapped) return canonical
  const [high, low] = [parseInt(mapped[1]!, 16), parseInt(mapped[2]!, 16)]
  return [high >> 8, high & 255, low >> 8, low & 255].join('.')
}
