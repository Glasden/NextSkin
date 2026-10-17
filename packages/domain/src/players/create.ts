import { createHash, randomUUID } from 'node:crypto'
import { insertOrIgnore, toIsoTimestamp, type CoreDatabase } from '@nextskin/db'
import type { Transaction } from 'kysely'
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
  if (!pattern.test(name)) throw new DomainError('player_name_invalid', { rule })
  return name
}

export function offlineUuid(name: string): string {
  const bytes = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest()
  bytes[6] = (bytes[6]! & 0x0f) | 0x30
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  return bytes.toString('hex')
}

/** name 已经过 validatePlayerName；必须和调用方的其他写入共用事务。 */
export async function createPlayer(
  tx: Transaction<CoreDatabase>,
  { uid, name, algorithm }: { uid: number; name: string; algorithm: CoreSettings['player.uuidAlgorithm'] },
): Promise<void> {
  let uuid = algorithm === 'offline' ? offlineUuid(name) : randomUUID().replaceAll('-', '')
  if (await tx.selectFrom('players').select('id').where('uuid', '=', uuid).executeTakeFirst())
    uuid = randomUUID().replaceAll('-', '')
  const now = toIsoTimestamp(new Date())
  const inserted = await insertOrIgnore(
    tx,
    'players',
    {
      user_id: uid,
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
  if (!inserted) throw new DomainError('player_name_taken')
}
