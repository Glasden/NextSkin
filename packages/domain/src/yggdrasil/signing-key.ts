import { createPrivateKey, createPublicKey, sign } from 'node:crypto'
import type { createSettingQueries } from '../settings/queries.ts'

export interface SigningKey {
  publicKey: string
  sign(value: string): string
}

export function parseSigningKey(pem: string | null): SigningKey | null {
  if (pem === null) return null
  try {
    const key = createPrivateKey(pem)
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 4096) return null
    return {
      publicKey: createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString(),
      sign: (value) => sign('RSA-SHA1', Buffer.from(value, 'utf8'), key).toString('base64'),
    }
  } catch {
    return null
  }
}

export function createSigningKeyQuery(settings: ReturnType<typeof createSettingQueries>) {
  let cachedPem: string | null | undefined
  let cachedKey: SigningKey | null = null
  return async function getSigningKey() {
    const { 'yggdrasil.signingKey': pem } = await settings.read(['yggdrasil.signingKey'])
    if (pem !== cachedPem) {
      cachedPem = pem
      cachedKey = parseSigningKey(pem)
    }
    return cachedKey
  }
}
