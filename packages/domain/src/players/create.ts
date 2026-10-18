import { createHash, randomUUID } from 'node:crypto'
import { insertOrIgnore, isUniqueViolation, toIsoTimestamp, type IsoTimestamp, type CoreDatabase } from '@nextskin/db'
import type { Player } from '@nextskin/plugin-sdk'
import type { Kysely, Transaction } from 'kysely'
import { DomainError } from '../errors.ts'
import type { CoreSettings } from '../settings/registry.ts'
import { toNameKey } from './queries.ts'

export type PlayerNameSettings = Pick<CoreSettings, 'player.nameRule' | 'player.nameRegex' | 'player.nameLength'>

export function validatePlayerName(input: string, settings: PlayerNameSettings): string {
  const name = input.trim()
  const { min, max } = settings['player.nameLength']
  const length = [...name].length
  if (length < min || length > max) throw new DomainError('player_name_length', { min, max })
  const rule = settings['player.nameRule']
  let pattern: RegExp
  switch (rule) {
    case 'official':
      pattern = /^[A-Za-z0-9_]+$/u
      break
    case 'cjk':
      // 与 BS 的 App\Rules\PlayerName 相同：再加 § 和基本区汉字
      pattern = /^[A-Za-z0-9_§\u4e00-\u9fff]+$/u
      break
    case 'utf8':
      pattern = /^\S+$/u
      break
    case 'custom':
      try {
        pattern = new RegExp(settings['player.nameRegex'], 'u')
      } catch {
        throw new DomainError('player_name_rule_misconfigured')
      }
  }
  if (!pattern.test(name) || name.includes('\u0000')) throw new DomainError('player_name_invalid', { rule })
  return name
}

export function offlineUuid(name: string): string {
  const bytes = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest()
  bytes[6] = (bytes[6]! & 0x0f) | 0x30
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  return bytes.toString('hex')
}

/** 离线 UUID 在预查之后才被别的角色占上，这次插入失败了（见 retryOnPlayerUuidRace） */
class PlayerUuidTaken extends Error {}

/**
 * 调用 createPlayer 的事务都包在这里面。离线 UUID 在预查时还空着，插入前却被并发创建、随后改名的角色占上了：
 * PG 抛唯一冲突（insertOrIgnore 只认 name_key），MySQL 由 createPlayer 判断出来。整个事务重来一次，
 * 这次预查会看到 UUID 已被占用，改用随机 UUID。SQLite 的写事务是串行的，碰不到这种交错
 */
export async function retryOnPlayerUuidRace<T>(db: Kysely<CoreDatabase>, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof PlayerUuidTaken || isUniqueViolation(db, error)) return run()
    throw error
  }
}

/** name 已经过 validatePlayerName；必须和调用方的其他写入共用事务，事务包在 retryOnPlayerUuidRace 里。 */
export async function createPlayer(
  tx: Transaction<CoreDatabase>,
  {
    uid,
    name,
    algorithm,
    scorePaid,
    now = toIsoTimestamp(new Date()),
  }: {
    uid: number
    name: string
    algorithm: CoreSettings['player.uuidAlgorithm']
    scorePaid: number
    now?: IsoTimestamp
  },
): Promise<Player> {
  let uuid = algorithm === 'offline' ? offlineUuid(name) : randomUUID().replaceAll('-', '')
  if (await tx.selectFrom('players').select('id').where('uuid', '=', uuid).executeTakeFirst())
    uuid = randomUUID().replaceAll('-', '')
  const inserted = await insertOrIgnore(
    tx,
    'players',
    {
      user_id: uid,
      score_paid: scorePaid,
      name,
      name_key: toNameKey(name),
      uuid,
      skin_texture_id: null,
      cape_texture_id: null,
      created_at: now,
      updated_at: now,
    },
    ['name_key'],
  )
  if (!inserted) {
    // MySQL 上任何唯一冲突都让 insertOrIgnore 返回 false：名字没有被占，撞上的就是 UUID
    if (await tx.selectFrom('players').select('id').where('name_key', '=', toNameKey(name)).executeTakeFirst())
      throw new DomainError('player_name_taken')
    throw new PlayerUuidTaken()
  }
  const row = await tx
    .selectFrom('players')
    .select('id')
    .where('name_key', '=', toNameKey(name))
    .executeTakeFirstOrThrow()
  return { pid: row.id, uid, name, uuid, skin: null, cape: null, updatedAt: now }
}
