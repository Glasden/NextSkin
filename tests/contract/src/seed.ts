// 把 world.ts 写进 NextSkin 的库，与录制脚本写进 BS 的数据等价，按 docs/schema.md 的导入对照转换。
// 这一步还没有写入用例，测试数据直接插表。
import { generateKeyPairSync } from 'node:crypto'
import { copyFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  coreMigrations,
  migrateToLatest,
  syncAutoIncrement,
  toIsoTimestamp,
  writeAuthDate,
  type CoreDatabase,
} from '@nextskin/db'
import { encodeSettingValue, toNameKey } from '@nextskin/domain'
import type { Kysely } from 'kysely'
import { players, settings, textureById, textures, users } from './world.ts'

const fixtures = new URL('../fixtures/textures/', import.meta.url)

export interface SeedOptions {
  /** 材质存储目录，文件按 hash 命名 */
  textureDirectory: string
  secretKey: string
  /** PKCS#8 PEM */
  signingKey: string
}

const iso = (value: string) => toIsoTimestamp(new Date(value))

/** Yggdrasil 签名密钥：authlib-injector 要求至少 4096 位。生成一次约一秒 */
export function generateSigningKey(): { privateKey: string; publicKey: string } {
  return generateKeyPairSync('rsa', {
    modulusLength: 4096,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
}

export async function seedWorld(db: Kysely<CoreDatabase>, options: SeedOptions): Promise<void> {
  await migrateToLatest(db, coreMigrations)
  const now = iso('2026-03-01T00:00:00.000Z')

  await db
    .insertInto('users')
    .values(
      users.map((user) => ({
        id: user.uid,
        nickname: user.nickname,
        email: user.email.toLowerCase(),
        email_verified: true,
        created_at: writeAuthDate(db, iso('2026-01-01T00:00:00.000Z')),
        updated_at: writeAuthDate(db, iso('2026-01-01T00:00:00.000Z')),
        role: user.role,
      })),
    )
    .execute()

  const files = new Map<string, { texture: (typeof textures)[number]; refCount: number }>()
  for (const texture of textures) {
    const entry = files.get(texture.file.hash)
    if (entry) entry.refCount++
    else files.set(texture.file.hash, { texture, refCount: 1 })
  }
  // stored: false 的文件同样是 active 的行，只是不复制进存储（见 world.ts）
  await db
    .insertInto('texture_files')
    .values(
      [...files.values()].map(({ texture, refCount }) => ({
        hash: texture.file.hash,
        pixel_hash: texture.file.pixelHash,
        width: texture.file.width,
        height: texture.file.height,
        size_bytes: texture.file.sizeBytes,
        ref_count: refCount,
        status: 'active' as const,
        status_changed_at: now,
        // BS 的 Last-Modified 是文件的修改时间，导入时取它
        created_at: iso(texture.fileModifiedAt),
      })),
    )
    .execute()
  await db
    .insertInto('textures')
    .values(
      textures.map((texture) => ({
        id: texture.tid,
        hash: texture.file.hash,
        name: texture.name,
        type: texture.type,
        uploader_id: texture.uploader,
        is_public: texture.isPublic ? (1 as const) : (0 as const),
        created_at: iso(texture.fileModifiedAt),
        updated_at: iso(texture.fileModifiedAt),
      })),
    )
    .execute()

  // 导入规则：tid 小于等于 0 或材质不存在时置空
  const textureId = (tid: number) => (tid > 0 && textureById(tid) ? tid : null)
  await db
    .insertInto('players')
    .values(
      players.map((player) => ({
        id: player.pid,
        user_id: player.uid,
        name: player.name,
        name_key: toNameKey(player.name),
        uuid: player.uuid,
        skin_texture_id: textureId(player.bsSkin),
        cape_texture_id: textureId(player.bsCape),
        created_at: iso(player.updatedAt),
        updated_at: iso(player.updatedAt),
      })),
    )
    .execute()

  const secret = { secretKey: options.secretKey }
  await db
    .insertInto('settings')
    .values(
      [
        { key: 'site.url', value: encodeSettingValue('site.url', settings.siteUrl, secret) },
        { key: 'site.name', value: encodeSettingValue('site.name', settings.siteName, secret) },
        { key: 'cache.publicMaxAge', value: encodeSettingValue('cache.publicMaxAge', settings.cacheMaxAge, secret) },
        {
          key: 'yggdrasil.skinDomains',
          value: encodeSettingValue('yggdrasil.skinDomains', settings.skinDomains, secret),
        },
        {
          key: 'yggdrasil.profileSearchLimit',
          value: encodeSettingValue('yggdrasil.profileSearchLimit', settings.profileSearchLimit, secret),
        },
        { key: 'yggdrasil.signingKey', value: encodeSettingValue('yggdrasil.signingKey', options.signingKey, secret) },
      ].map((row) => ({ namespace: 'core', updated_at: now, ...row })),
    )
    .execute()

  for (const table of ['users', 'textures', 'players'] as const) await syncAutoIncrement(db, table)

  await mkdir(options.textureDirectory, { recursive: true })
  for (const [hash, { texture }] of files) {
    if (!texture.stored) continue
    await copyFile(fileURLToPath(new URL(texture.file.file, fixtures)), join(options.textureDirectory, hash))
  }
}
