/**
 * 插件读核心数据（`users.read`、`players.read`、`textures.read`、`textures.readFile`）。
 * 只返回 SDK 的 DTO；按 id 读，成本很低（ADR-0033）。按昵称搜索的用户每次最多 100 个（ADR-0050）。
 */
import { containsInsensitive, readAuthBoolean, readAuthDate, type CoreDatabase, type UsersTable } from '@nextskin/db'
import type { Player, PrivateUser, PublicUser, Texture } from '@nextskin/plugin-sdk'
import type { Kysely, Selectable } from 'kysely'
import { toPlayer } from '../players/manage.ts'
import { toNameKey } from '../players/queries.ts'
import { textureRows, toTexture } from '../textures/dto.ts'
import type { TextureStorage } from '../textures/storage.ts'
import { PluginCallRejected } from './errors.ts'

/** 一次 getMany 最多查多少个 */
const MAX_BATCH = 100

function toPublicUser(row: Selectable<UsersTable>): PublicUser {
  return {
    uid: row.id,
    nickname: row.nickname,
    role: row.role,
    avatarTid: row.avatar_texture_id,
    registeredAt: readAuthDate(row.created_at),
  }
}

function toPrivateUser(row: Selectable<UsersTable>): PrivateUser {
  return {
    ...toPublicUser(row),
    email: row.email,
    emailVerified: readAuthBoolean(row.email_verified),
    score: row.score,
    locale: row.locale,
  }
}

function id(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new PluginCallRejected(`${what} 必须是正整数`)
  return value
}

function text(value: unknown, what: string, max = 255): string {
  if (typeof value !== 'string' || value.length > max) throw new PluginCallRejected(`${what} 必须是字符串`)
  return value
}

function batchLimit(value: unknown): number {
  if (value === undefined) return MAX_BATCH
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_BATCH)
    throw new PluginCallRejected(`limit 必须是 1 到 ${MAX_BATCH} 的整数`)
  return value
}

export function createPluginCoreData(db: Kysely<CoreDatabase>, storage: TextureStorage) {
  return {
    async user(uid: unknown, privateFields: boolean): Promise<PublicUser | PrivateUser | null> {
      const row = await db.selectFrom('users').selectAll().where('id', '=', id(uid, 'uid')).executeTakeFirst()
      return row ? (privateFields ? toPrivateUser(row) : toPublicUser(row)) : null
    },
    async users(uids: unknown, privateFields: boolean): Promise<(PublicUser | PrivateUser)[]> {
      if (!Array.isArray(uids) || uids.length > MAX_BATCH)
        throw new PluginCallRejected(`uids 必须是数组，最多 ${MAX_BATCH} 个`)
      const ids = [...new Set(uids.map((uid) => id(uid, 'uid')))]
      if (!ids.length) return []
      const rows = await db.selectFrom('users').selectAll().where('id', 'in', ids).orderBy('id').execute()
      return rows.map(privateFields ? toPrivateUser : toPublicUser)
    },
    async usersByNickname(
      query: unknown,
      after: unknown,
      limit: unknown,
      privateFields: boolean,
    ): Promise<(PublicUser | PrivateUser)[]> {
      const q = text(query, 'query')
      if (!q) throw new PluginCallRejected('query 不能是空串')
      const from = after === undefined ? 0 : id(after, 'after')
      const take = batchLimit(limit)
      // 昵称里不会有 NUL（users/validation.ts），PostgreSQL 收到 NUL 还会报错
      if (q.includes('\0')) return []
      const rows = await db
        .selectFrom('users')
        .selectAll()
        .where(containsInsensitive('nickname', q))
        .where('id', '>', from)
        .orderBy('id')
        .limit(take)
        .execute()
      return rows.map(privateFields ? toPrivateUser : toPublicUser)
    },
    async userByEmail(email: unknown): Promise<PrivateUser | null> {
      // 邮箱入库时已经规范成小写（users/validation.ts）
      const row = await db
        .selectFrom('users')
        .selectAll()
        .where('email', '=', text(email, 'email').trim().toLowerCase())
        .executeTakeFirst()
      return row ? toPrivateUser(row) : null
    },
    async player(pid: unknown): Promise<Player | null> {
      const row = await db.selectFrom('players').selectAll().where('id', '=', id(pid, 'pid')).executeTakeFirst()
      return row ? toPlayer(row) : null
    },
    async playerByName(name: unknown): Promise<Player | null> {
      const row = await db
        .selectFrom('players')
        .selectAll()
        .where('name_key', '=', toNameKey(text(name, 'name')))
        .executeTakeFirst()
      return row ? toPlayer(row) : null
    },
    async playerByUuid(uuid: unknown): Promise<Player | null> {
      const value = text(uuid, 'uuid').replaceAll('-', '').toLowerCase()
      if (!/^[0-9a-f]{32}$/.test(value)) return null
      const row = await db.selectFrom('players').selectAll().where('uuid', '=', value).executeTakeFirst()
      return row ? toPlayer(row) : null
    },
    async playersOf(uid: unknown): Promise<Player[]> {
      const rows = await db
        .selectFrom('players')
        .selectAll()
        .where('user_id', '=', id(uid, 'uid'))
        .orderBy('id')
        .execute()
      return rows.map(toPlayer)
    },
    async texture(tid: unknown): Promise<Texture | null> {
      const row = await textureRows(db).where('textures.id', '=', id(tid, 'tid')).executeTakeFirst()
      return row ? toTexture(row) : null
    },
    async textureByHash(hash: unknown): Promise<Texture | null> {
      const value = text(hash, 'hash', 64)
      // SDK：同一 hash 可有多个条目，优先返回公开的，其次取 tid 最小的
      const row = await textureRows(db)
        .where('textures.hash', '=', value)
        .orderBy('textures.is_public', 'desc')
        .orderBy('textures.id', 'asc')
        .executeTakeFirst()
      return row ? toTexture(row) : null
    },
    async textureFile(hash: unknown): Promise<Uint8Array | null> {
      const value = text(hash, 'hash', 64)
      if (!/^[0-9a-f]{64}$/.test(value)) return null
      // 只读还有条目引用的文件：回收中的文件对插件来说已经不存在了
      const row = await db
        .selectFrom('texture_files')
        .select('hash')
        .where('hash', '=', value)
        .where('status', '=', 'active')
        .executeTakeFirst()
      return row ? storage.read(value) : null
    },
  }
}

export type PluginCoreData = ReturnType<typeof createPluginCoreData>
