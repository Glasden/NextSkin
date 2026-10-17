// bcrypt、argon2 保留自带标识的哈希；旧摘要存成 $bs$<算法>$<小写十六进制摘要>。
// BS 的 SALT 是全站共用的 pepper，另存于加密设置，由调用方传入，不写进哈希。
import { createHash, timingSafeEqual } from 'node:crypto'
import { argon2Verify, bcryptVerify } from 'hash-wasm'

const digestLengths = {
  md5: 32,
  salted2md5: 32,
  sha256: 64,
  salted2sha256: 64,
  sha512: 128,
  salted2sha512: 128,
} as const

export type LegacyDigestAlgorithm = keyof typeof digestLengths

function isDigestAlgorithm(algorithm: string): algorithm is LegacyDigestAlgorithm {
  return Object.hasOwn(digestLengths, algorithm)
}

export function legacyDigestAlgorithm(pwdMethod: string): LegacyDigestAlgorithm | null {
  switch (pwdMethod) {
    case 'BCRYPT':
    case 'ARGON2I':
    case 'PHP_PASSWORD_HASH':
      return null
    default: {
      const algorithm = pwdMethod.toLowerCase()
      if (isDigestAlgorithm(algorithm) && pwdMethod === algorithm.toUpperCase()) return algorithm
      throw new Error(
        '不支持此 PWD_METHOD；支持 BCRYPT、ARGON2I、PHP_PASSWORD_HASH、MD5、SALTED2MD5、SHA256、SALTED2SHA256、SHA512、SALTED2SHA512',
      )
    }
  }
}

export function formatLegacyDigest(algorithm: LegacyDigestAlgorithm, hexDigest: string): string {
  if (!isDigestAlgorithm(algorithm) || hexDigest.length !== digestLengths[algorithm] || /[^a-f0-9]/i.test(hexDigest))
    throw new Error('旧密码摘要格式不对；请提供对应算法长度的十六进制摘要')
  return `$bs$${algorithm}$${hexDigest.toLowerCase()}`
}

export function isLegacyPasswordHash(hash: string): boolean {
  return /^(?:\$2[aby]\$|\$argon2(?:i|id)\$|\$bs\$)/.test(hash)
}

export async function verifyLegacyPassword({
  hash,
  password,
  salt,
}: {
  hash: string
  password: string
  salt: string
}): Promise<boolean> {
  try {
    if (/^\$2[aby]\$/.test(hash)) {
      // hash-wasm 拒绝超过 72 字节的输入；PHP 按字节截断，不能转回字符串。
      const bytes = Buffer.from(password, 'utf8').subarray(0, 72)
      // 底层 bcrypt 使用 C 字符串；单个 NUL 与 PHP 的空密码等价。
      return await bcryptVerify({ hash, password: bytes.length === 0 ? new Uint8Array(1) : bytes })
    }

    if (/^\$argon2(?:i|id)\$/.test(hash)) {
      const match =
        /^\$argon2(?:i|id)\$v=19\$m=([1-9]\d{0,5}),t=([1-9]\d?),p=([1-9])\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(
          hash,
        )
      if (!match || match[0] !== hash) return false
      const memory = Number(match[1])
      const iterations = Number(match[2])
      const parallelism = Number(match[3])
      // BS 调用 password_hash 时不传参数，正常的值是 PHP 默认的 m=65536,t=4,p=1。超出上限的哈希 PHP 能校验，
      // 这里一律当作不通过：一条异常数据不能让每次登录分配几 GB 内存
      if (memory > 262144 || iterations > 16 || parallelism > 8 || memory < 8 * parallelism) return false
      // Buffer 的 base64 解码很宽松；拒绝非规范编码，避免坏盐被当成有效数据。
      if (
        match
          .slice(4)
          .some((encoded) => Buffer.from(encoded, 'base64').toString('base64').replace(/=+$/, '') !== encoded)
      )
        return false
      // hash-wasm 4.12.0 不接受空 Argon2 密码，异常会在下方转为 false。
      return await argon2Verify({ hash, password })
    }

    const parts = hash.split('$')
    if (parts.length !== 4 || parts[0] !== '' || parts[1] !== 'bs') return false
    const algorithm = parts[2]
    const expected = parts[3]
    if (!algorithm || !isDigestAlgorithm(algorithm) || !expected) return false
    // 只接受约定的小写存储格式；导入时由 formatLegacyDigest 统一大小写。
    if (expected.length !== digestLengths[algorithm] || /[^a-f0-9]/.test(expected)) return false
    const salted = algorithm.startsWith('salted2')
    const digestAlgorithm = salted ? algorithm.slice('salted2'.length) : algorithm
    let actual = createHash(digestAlgorithm).update(password, 'utf8').digest('hex')
    if (salted)
      actual = createHash(digestAlgorithm)
        .update(actual + salt, 'utf8')
        .digest('hex')
    return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))
  } catch {
    // 坏数据和底层解析错误均视为校验失败，不传播可能包含敏感值的错误。
    return false
  }
}
