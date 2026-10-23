import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { compareVersions, keyIdPattern, releaseVersionPattern } from './versions.ts'

export { compareVersions, releaseVersionPattern } from './versions.ts'

/** 核心和管理进程使用同一份清单。 */
export const MANIFEST_URL = 'https://dl.nextskin.org/releases/v1.json'
export const MANAGER_PROTOCOL = 1
/**
 * 内置的发布公钥：key id → SPKI PEM。私钥只在 GitHub 的 release 环境里（ADR-0061）。
 * 换钥：先发一个同时内置新旧公钥的版本，再改 release-site.yml 的 key id 和 secret；旧公钥泄露了才删掉它。
 * 公钥也放在文档站的 apps/docs/public/release-keys/<key id>.pem，给手动校验 SHA256SUMS.sig 的人用，测试守着两边一致
 */
export const RELEASE_KEYS: Readonly<Record<string, string>> = {
  '2026-10': `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEALhERgqjUtP4iJTNiCVrPIL8RmWfVbbMZvyQFE/JeKlI=
-----END PUBLIC KEY-----
`,
}

export interface ReleaseEntry {
  version: string
  date: string
  notes: string
  file: string
  sha256: string
  size: number
  minNode: number
  managerProtocol: number
}

export interface SignedEntry {
  /** 保留原始 JSON 文本，因为签名覆盖它的 UTF-8 字节。 */
  entry: string
  key: string
  signature: string
}

export interface ReleaseManifest {
  schema: 1
  releases: SignedEntry[]
}

export function downloadUrls(entry: Pick<ReleaseEntry, 'version' | 'file'>): string[] {
  return [
    `https://dl.nextskin.org/releases/${entry.version}/${entry.file}`,
    `https://github.com/Glasden/NextSkin/releases/download/v${entry.version}/${entry.file}`,
  ]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isReleaseEntry(value: unknown): value is ReleaseEntry {
  if (!isObject(value)) return false
  const fields = ['version', 'date', 'notes', 'file', 'sha256', 'size', 'minNode', 'managerProtocol']
  if (Object.keys(value).length !== fields.length || !fields.every((field) => Object.hasOwn(value, field))) return false
  if (typeof value.version !== 'string' || !releaseVersionPattern.test(value.version)) return false
  if (value.file !== `nextskin-${value.version}.zip`) return false
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) return false
  if (!positiveInteger(value.size) || value.size > 1024 ** 3) return false
  if (!positiveInteger(value.minNode) || !positiveInteger(value.managerProtocol)) return false
  if (typeof value.notes !== 'string' || !value.notes.startsWith('https://')) return false
  try {
    if (!new URL(value.notes).hostname) return false
  } catch {
    return false
  }
  if (typeof value.date !== 'string') return false
  const date = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value.date)
  // Date.parse 会把 2 月 30 日归一化，因此还要和解析后的 UTC 时间逐字段核对。
  return (
    !!date &&
    Number.isFinite(Date.parse(value.date)) &&
    new Date(value.date).toISOString() === `${date[1]}.${(date[2] ?? '').padEnd(3, '0')}Z`
  )
}

export function signDetached(data: Uint8Array, privateKeyPem: string): Buffer {
  const key = createPrivateKey(privateKeyPem)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('发布签名必须使用 ed25519 私钥')
  return sign(null, data, key)
}

export function verifyDetached(data: Uint8Array, signature: Uint8Array, publicKeyPem: string): boolean {
  try {
    if (signature.length !== 64) return false
    const key = createPublicKey(publicKeyPem)
    return key.asymmetricKeyType === 'ed25519' && verify(null, data, key, signature)
  } catch {
    return false
  }
}

export function signEntry(entry: ReleaseEntry, privateKeyPem: string, keyId: string): SignedEntry {
  if (!isReleaseEntry(entry) || !keyIdPattern.test(keyId)) throw new Error('发布条目或 key id 不合法')
  const body = JSON.stringify(entry)
  return {
    entry: body,
    key: keyId,
    signature: signDetached(Buffer.from(body, 'utf8'), privateKeyPem).toString('base64'),
  }
}

export function verifyEntry(
  signed: unknown,
  keys: Readonly<Record<string, string>> = RELEASE_KEYS,
): ReleaseEntry | null {
  try {
    if (
      !isObject(signed) ||
      Object.keys(signed).length !== 3 ||
      !['entry', 'key', 'signature'].every((field) => Object.hasOwn(signed, field))
    )
      return null
    const { entry, key, signature } = signed
    if (typeof entry !== 'string' || typeof key !== 'string' || typeof signature !== 'string') return null
    if (!keyIdPattern.test(key) || !Object.hasOwn(keys, key) || typeof keys[key] !== 'string') return null
    // Buffer.from 对非法 base64 很宽容，先限制格式，再检查编码是否为规范形式。
    if (!/^[A-Za-z0-9+/]{86}==$/.test(signature)) return null
    const bytes = Buffer.from(signature, 'base64')
    if (bytes.toString('base64') !== signature || !verifyDetached(Buffer.from(entry, 'utf8'), bytes, keys[key]))
      return null
    const parsed: unknown = JSON.parse(entry)
    return isReleaseEntry(parsed) ? parsed : null
  } catch {
    return null
  }
}

export class ManifestError extends Error {
  override name = 'ManifestError'
}

export function readManifest(
  body: unknown,
  keys: Readonly<Record<string, string>> = RELEASE_KEYS,
): { releases: ReleaseEntry[]; rejected: number } {
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      throw new ManifestError('版本清单不是合法 JSON')
    }
  }
  if (
    !isObject(body) ||
    Object.keys(body).length !== 2 ||
    !Object.hasOwn(body, 'schema') ||
    !Object.hasOwn(body, 'releases') ||
    body.schema !== 1 ||
    !Array.isArray(body.releases)
  ) {
    throw new ManifestError('版本清单的结构或 schema 不支持')
  }
  const releases: ReleaseEntry[] = []
  const versions = new Set<string>()
  let rejected = 0
  for (const signed of body.releases) {
    const entry = verifyEntry(signed, keys)
    if (!entry || versions.has(entry.version)) {
      rejected++
      continue
    }
    versions.add(entry.version)
    releases.push(entry)
  }
  return { releases, rejected }
}

export function newerReleases(current: string, releases: readonly ReleaseEntry[]): ReleaseEntry[] {
  // 即使清单为空，也不能静默接受无效的当前版本。
  compareVersions(current, current)
  return releases
    .filter((entry) => releaseVersionPattern.test(entry.version) && compareVersions(entry.version, current) > 0)
    .sort((a, b) => compareVersions(b.version, a.version))
}
