import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { coreSettingsNamespace, coreSettingsRegistry, type CoreSettingKey, type CoreSettingValue } from './registry.ts'

const salt = 'NextSkin settings encryption v1'
const info = 'core settings AES-256-GCM'
const envelopeSchema = z
  .object({
    v: z.literal(1),
    iv: z.base64(),
    tag: z.base64(),
    data: z.base64(),
  })
  .strict()

export function validateSecretKey(secretKey: string): void {
  if (secretKey.length < 32)
    throw new Error('加密设置用的密钥太短；请把 NEXTSKIN_SECRET 设为至少 32 个字符的随机字符串')
}

function encryptionKey(secretKey: string) {
  return Buffer.from(hkdfSync('sha256', secretKey, salt, info, 32))
}

function aad(key: CoreSettingKey) {
  return Buffer.from(`${coreSettingsNamespace}:${key}`, 'utf8')
}

export function encodeSettingValue<K extends CoreSettingKey>(
  key: K,
  value: CoreSettingValue<K>,
  options: { secretKey: string },
): string {
  validateSecretKey(options.secretKey)
  try {
    const definition = coreSettingsRegistry[key]
    const json = JSON.stringify(definition.schema.parse(value))
    if (!definition.secret) return json
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', encryptionKey(options.secretKey), iv)
    cipher.setAAD(aad(key))
    const data = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()])
    return JSON.stringify({
      v: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    })
  } catch {
    throw new Error(`设置项 ${key} 的值不符合它的类型；请检查要写入的值`)
  }
}

export function decodeSettingValue<K extends CoreSettingKey>(
  key: K,
  stored: string,
  secretKey: string,
): CoreSettingValue<K> {
  try {
    const definition = coreSettingsRegistry[key]
    let value: unknown = JSON.parse(stored)
    if (definition.secret) {
      const envelope = envelopeSchema.parse(value)
      const iv = Buffer.from(envelope.iv, 'base64')
      const tag = Buffer.from(envelope.tag, 'base64')
      if (iv.length !== 12 || tag.length !== 16) throw new Error()
      const decipher = createDecipheriv('aes-256-gcm', encryptionKey(secretKey), iv)
      decipher.setAAD(aad(key))
      decipher.setAuthTag(tag)
      const json = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString(
        'utf8',
      )
      value = JSON.parse(json)
    }
    return definition.schema.parse(value) as CoreSettingValue<K>
  } catch {
    // 不保留 cause：zod/crypto 的底层错误可能包含设置值。
    throw new Error(
      `设置项 ${key} 读取失败：存储的值格式不对，或者 NEXTSKIN_SECRET 与写入时不同；请在后台重新设置这一项`,
    )
  }
}
