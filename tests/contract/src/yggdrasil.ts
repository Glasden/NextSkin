// Yggdrasil 响应里不能逐字节比较的部分：签名、公钥、textures 属性里的时间戳。
import { createPublicKey, verify } from 'node:crypto'

/** authlib-injector 要求签名公钥至少 4096 位（BS 的 yggdrasil-api 也这样检查）。 */
export function assertSigningPublicKey(pem: unknown): string {
  if (
    typeof pem !== 'string' ||
    !pem.startsWith('-----BEGIN PUBLIC KEY-----\n') ||
    !pem.endsWith('-----END PUBLIC KEY-----\n')
  ) {
    throw new Error(`signaturePublickey 不是 SPKI 格式的 PEM：${JSON.stringify(pem)}`)
  }
  const key = createPublicKey(pem)
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0
  if (key.asymmetricKeyType !== 'rsa' || bits < 4096) {
    throw new Error(`signaturePublickey 必须是至少 4096 位的 RSA 公钥，实际是 ${key.asymmetricKeyType} ${bits} 位`)
  }
  return pem
}

/** 属性签名：对 value 字符串（base64 文本本身）做 SHA1withRSA，与 Mojang 和 BS 相同。 */
export function verifyPropertySignature(value: string, signature: string, publicKeyPem: string): boolean {
  return verify('sha1', Buffer.from(value, 'utf8'), publicKeyPem, Buffer.from(signature, 'base64'))
}

export function decodeTexturesValue(value: string): Record<string, unknown> {
  const decoded: unknown = JSON.parse(Buffer.from(value, 'base64').toString('utf8'))
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('textures 属性解码后不是对象')
  return decoded as Record<string, unknown>
}
