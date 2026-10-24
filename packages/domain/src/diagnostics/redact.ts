import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { redactSecrets } from '@nextskin/logging'

function privateV4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number)
  return (
    ip === '0.0.0.0' ||
    a === 10 ||
    a === 127 ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  )
}
function privateIp(ip: string): boolean {
  if (isIP(ip) === 4) return privateV4(ip)
  // URL 把 IPv6 规范成压缩、小写形式，同时把映射地址的十进制尾部转为十六进制。
  const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1)
  if (canonical === '::' || canonical === '::1') return true
  const first = Number.parseInt(canonical.split(':')[0] || '0', 16)
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80) return true
  const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/u.exec(canonical)
  if (!mapped) return false
  const high = Number.parseInt(mapped[1]!, 16),
    low = Number.parseInt(mapped[2]!, 16)
  return privateV4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
}
const IPV4 = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/gu
// 局部不含 /：pnpm 路径里的 node_modules/.pnpm/pino@10.4.0 不是邮箱；顶级域名要有字母，版本号的 @1.2.3 也不是。
// 只从一串局部字符的开头试：不然没有 @ 的长串每个位置都要扫到尾，16 KB 的一行就要零点几秒
const EMAIL = /(?<![\w.!#$%&'*+=?^`{|}~-])[\w.!#$%&'*+=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)*\.[a-z][\w-]*/giu
// IPv6 的候选不从地址中间开始（前面是十六进制位加冒号），但 ip:2001:db8::1 这种字段名加冒号的可以；
// 不是 IPv6 的候选（203.0.113.5:3000 这种带端口的 v4、12:30:45.123 这种时间）里再找 v4
const IP_CANDIDATE =
  /(?<![\w.])(?<![\da-f:.]:)(?=[\da-f:.]*:)[\da-f:.]+(?![\w:.])|(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/giu
const normalizedPath = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/u, '')
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 一个导出包复用一个实例，字符串逐个处理，JSON 的键名保持原样。 */
export function createDiagnosticsRedactor(options: {
  instanceDirectory: string
  dataDirectory: string
  homeDirectory?: string
}) {
  const emails = new Map<string, number>(),
    ips = new Map<string, number>()
  const numbered = (map: Map<string, number>, key: string, label: string) => {
    if (!map.has(key)) map.set(key, map.size + 1)
    return `<${label}${map.get(key)}>`
  }
  const instance = normalizedPath(options.instanceDirectory)
  const data = normalizedPath(options.dataDirectory)
  const inside = (path: string, parent: string) =>
    path.toLowerCase() === parent.toLowerCase() || path.toLowerCase().startsWith(`${parent.toLowerCase()}/`)
  const directories: [string, string][] = [
    [instance, '<实例目录>'],
    ...(!inside(data, instance) ? [[data, '<数据目录>'] as [string, string]] : []),
    [normalizedPath(options.homeDirectory ?? homedir()), '~'],
  ]
  const paths = directories
    .filter(([path]) => path)
    // file:// 地址里的路径是百分号编码的：C:/Users/Alice%20Smith
    .flatMap(([path, replacement]): [string, string][] =>
      encodeURI(path) === path
        ? [[path, replacement]]
        : [
            [path, replacement],
            [encodeURI(path), replacement],
          ],
    )
    .sort((a, b) => b[0].length - a[0].length)
    .map(([path, replacement]) => {
      // 开头的 / 只认一个：file:///app 里换掉的是 /app
      const segments = path.split('/').map(escape)
      const pattern = segments[0] === '' ? `[/\\\\]${segments.slice(1).join('[/\\\\]+')}` : segments.join('[/\\\\]+')
      // 同名的目录前缀不能匹配 /instance-other，也不匹配别的路径中间的同名段（实例目录是 /app 时的 web/app/admin）；
      // 前面是 / 的照样换：file:///app/server.js。后面只要不是接着的文件名就换：全角标点、句末的点、紧跟的中文都算结束，
      // 宁可把 /data中文 换成 <数据目录>中文，也不漏掉"数据目录 /data，"。JSON 字符串在序列化前脱敏。
      return [new RegExp(`(?<![\\w.-])${pattern}(?![\\w%-]|\\.[\\w%-])`, 'giu'), replacement] as const
    })
  function text(input: string): string {
    const v4 = (ip: string) => (isIP(ip) === 4 && !privateV4(ip) ? numbered(ips, ip, 'IP') : ip)
    let value = redactSecrets(input)
      .replace(EMAIL, (email) => numbered(emails, email.toLowerCase(), '邮箱'))
      // 同一遍按出现顺序编号；IPv6 候选串必须通过 isIP，不能把其中的 v4 尾部单独替换
      .replace(IP_CANDIDATE, (candidate) => {
        const ip = candidate.includes(':') ? candidate.replace(/\.+$/u, '') : candidate
        const suffix = candidate.slice(ip.length)
        const family = isIP(ip)
        if (!family) return candidate.replace(IPV4, v4)
        if (privateIp(ip)) return candidate
        const canonical = family === 4 ? ip : new URL(`http://[${ip}]/`).hostname.toLowerCase()
        return numbered(ips, canonical, 'IP') + suffix
      })
    for (const [pattern, replacement] of paths) value = value.replace(pattern, replacement)
    return value
  }
  function value(input: unknown): unknown {
    if (typeof input === 'string') return text(input)
    if (Array.isArray(input)) return input.map(value)
    if (input && typeof input === 'object')
      return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, value(item)]))
    return input
  }
  return { text, value }
}
