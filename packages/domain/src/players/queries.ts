import { textureScale, TextureShapeError } from '@nextskin/skin'
import type { CoreDatabase, IsoTimestamp, TextureType } from '@nextskin/db'
import type { Kysely } from 'kysely'

export const toNameKey = (name: string): string => name.toLowerCase()

/** MySQL PAD SPACE 只忽略末尾 U+0020，不忽略开头空格或其他空白。 */
export function normalizeNameLookup(name: string): string | null {
  return toNameKey(name.replace(/ +$/, '')) || null
}

export function normalizeUuidLookup(uuid: string): string | null {
  const normalized = uuid.replace(/ +$/, '').toLowerCase()
  return /^[0-9a-f]{32}$/.test(normalized) ? normalized : null
}

export interface PlayerView {
  pid: number
  name: string
  uuid: string
  updatedAt: string
  ownerBanned: boolean
  skin: { tid: number; hash: string; type: TextureType } | null
  cape: { tid: number; hash: string } | null
}

export interface OwnedPlayer {
  pid: number
  name: string
  uuid: string
  skin: { tid: number; hash: string; type: 'steve' | 'alex'; scale: number } | null
  cape: { tid: number; hash: string; scale: number } | null
  /** 创建时实际扣的积分，删除时按它退还（ADR-0022） */
  scorePaid: number
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

export function textureScaleOrNull(
  type: TextureType | null,
  width: number | null,
  height: number | null,
): number | null {
  if (type === null || width === null || height === null) return null
  try {
    return textureScale(type, width, height)
  } catch (error) {
    if (error instanceof TextureShapeError) return null
    throw error
  }
}

export function createPlayerQueries(db: Kysely<CoreDatabase>) {
  async function find(column: 'players.name_key' | 'players.uuid', value: string | null): Promise<PlayerView | null> {
    if (value === null) return null
    const row = await db
      .selectFrom('players')
      .innerJoin('users', 'users.id', 'players.user_id')
      .leftJoin('textures as skin', 'skin.id', 'players.skin_texture_id')
      .leftJoin('textures as cape', 'cape.id', 'players.cape_texture_id')
      .select([
        'players.id as pid',
        'players.name',
        'players.name_key',
        'players.uuid',
        'players.updated_at as updatedAt',
        'users.role',
        'skin.id as skinId',
        'skin.hash as skinHash',
        'skin.type as skinType',
        'cape.id as capeId',
        'cape.hash as capeHash',
      ])
      .where(column, '=', value)
      .executeTakeFirst()
    if (!row || (column === 'players.name_key' ? row.name_key : row.uuid) !== value) return null
    return {
      pid: row.pid,
      name: row.name,
      uuid: row.uuid,
      updatedAt: row.updatedAt,
      ownerBanned: row.role === 'banned',
      skin:
        row.skinId !== null && row.skinHash !== null && row.skinType !== null
          ? { tid: row.skinId, hash: row.skinHash, type: row.skinType }
          : null,
      cape: row.capeId !== null && row.capeHash !== null ? { tid: row.capeId, hash: row.capeHash } : null,
    }
  }
  return {
    async listOwned(uid: number): Promise<OwnedPlayer[]> {
      const rows = await db
        .selectFrom('players')
        .leftJoin('textures as skin', 'skin.id', 'players.skin_texture_id')
        .leftJoin('textures as cape', 'cape.id', 'players.cape_texture_id')
        .leftJoin('texture_files as skinFile', 'skinFile.hash', 'skin.hash')
        .leftJoin('texture_files as capeFile', 'capeFile.hash', 'cape.hash')
        .select([
          'players.id as pid',
          'players.name',
          'players.uuid',
          'players.score_paid as scorePaid',
          'players.created_at as createdAt',
          'players.updated_at as updatedAt',
          'skin.id as skinId',
          'skin.hash as skinHash',
          'skin.type as skinType',
          'cape.id as capeId',
          'cape.hash as capeHash',
          'cape.type as capeType',
          'skinFile.width as skinWidth',
          'skinFile.height as skinHeight',
          'capeFile.width as capeWidth',
          'capeFile.height as capeHeight',
        ])
        .where('players.user_id', '=', uid)
        .orderBy('players.id', 'asc')
        .execute()
      return rows.map(
        ({
          skinId,
          skinHash,
          skinType,
          capeId,
          capeHash,
          capeType,
          skinWidth,
          skinHeight,
          capeWidth,
          capeHeight,
          ...player
        }) => {
          const skinScale = textureScaleOrNull(skinType, skinWidth, skinHeight)
          const capeScale = textureScaleOrNull(capeType, capeWidth, capeHeight)
          return {
            ...player,
            skin:
              skinId !== null &&
              skinHash !== null &&
              skinScale !== null &&
              (skinType === 'steve' || skinType === 'alex')
                ? { tid: skinId, hash: skinHash, type: skinType, scale: skinScale }
                : null,
            cape:
              capeId !== null && capeHash !== null && capeType === 'cape' && capeScale !== null
                ? { tid: capeId, hash: capeHash, scale: capeScale }
                : null,
          }
        },
      )
    },
    findByName: (name: string) => find('players.name_key', normalizeNameLookup(name)),
    findByUuid: (uuid: string) => find('players.uuid', normalizeUuidLookup(uuid)),
  }
}
