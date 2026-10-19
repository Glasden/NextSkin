import { containsInsensitive, countRows, type CoreDatabase } from '@nextskin/db'
import type { Texture } from '../dto.ts'
import type { Kysely } from 'kysely'
import { textureScaleOrNull } from '../players/queries.ts'
import type { createSettingQueries } from '../settings/queries.ts'
import { storageFee, textureRows, toTexture, type TextureRow } from './dto.ts'
import type { TextureStorage } from './storage.ts'

export function createTextureQueries(db: Kysely<CoreDatabase>, storage: Pick<TextureStorage, 'read'>) {
  async function findFile(hash: string) {
    const row = await db
      .selectFrom('texture_files')
      .select(['hash', 'size_bytes as sizeBytes', 'created_at as createdAt'])
      .where('hash', '=', hash)
      .where('status', '=', 'active')
      .executeTakeFirst()
    // MySQL 的 PAD SPACE 比较会接受尾随空格；文件键必须逐字相同。
    return row?.hash === hash ? row : null
  }
  return {
    findFile,
    async readFile(hash: string) {
      const file = await findFile(hash)
      if (!file) return null
      const bytes = await storage.read(hash)
      return bytes === null ? null : { ...file, bytes }
    },
  }
}

export interface TextureSummary extends Texture {
  scale: number
  uploaderName: string | null
  inCloset: boolean
}
export interface TextureDetail extends Omit<TextureSummary, 'uploader'> {
  closetItem: { name: string; scorePaid: number } | null
  reported: boolean
  uploader: { uid: number; nickname: string; avatar: { hash: string; scale: number } | null } | null
  management?: { visibilityDelta: number; deleteRefund: number; othersInCloset: number }
}
export interface TextureListInput {
  viewer: number | null
  type: 'skin' | 'steve' | 'alex' | 'cape'
  q?: string
  uploader?: number
  sort: 'latest' | 'popular'
  page: number
  perPage?: number
}
export function createTextureLibraryQueries(
  db: Kysely<CoreDatabase>,
  settings: ReturnType<typeof createSettingQueries>,
) {
  const rows = () =>
    textureRows(db)
      .leftJoin('users as uploader', 'uploader.id', 'textures.uploader_id')
      .select('uploader.nickname as uploaderName')
  async function summaries(
    viewer: number | null,
    found: (TextureRow & { uploaderName: string | null })[],
  ): Promise<TextureSummary[]> {
    const closet =
      viewer === null || !found.length
        ? []
        : await db
            .selectFrom('closet_items')
            .select('texture_id')
            .where('user_id', '=', viewer)
            .where(
              'texture_id',
              'in',
              found.map((row) => row.id),
            )
            .execute()
    const ids = new Set(closet.map((item) => item.texture_id))
    return found.map((row) => ({
      ...toTexture(row),
      // 导入的尺寸不合法时，列表和详情仍保留条目，预览回退到标准倍率。
      scale: textureScaleOrNull(row.type, row.width, row.height) ?? 1,
      uploaderName: row.uploaderName,
      inCloset: ids.has(row.id),
    }))
  }
  return {
    async list(input: TextureListInput): Promise<{ items: TextureSummary[]; total: number }> {
      const perPage = Math.max(1, Math.min(60, Math.trunc(input.perPage ?? 20)))
      const page = Math.max(1, Math.trunc(input.page))
      let query = rows().where('textures.type', 'in', input.type === 'skin' ? ['steve', 'alex'] : [input.type])
      if (input.uploader !== undefined) query = query.where('textures.uploader_id', '=', input.uploader)
      if (input.uploader === undefined || input.viewer === null || input.uploader !== input.viewer)
        query = query.where('textures.is_public', '=', 1)
      const q = input.q?.trim()
      if (q) query = query.where(containsInsensitive('textures.name', q))
      const total = await countRows(query.clearSelect())
      if (input.sort === 'popular') query = query.orderBy('textures.likes', 'desc')
      const found = await query
        .orderBy('textures.id', 'desc')
        .limit(perPage)
        .offset((page - 1) * perPage)
        .execute()
      return { items: await summaries(input.viewer, found), total }
    },
    async detail(viewer: number | null, tid: number): Promise<TextureDetail | null> {
      const row = await rows().where('textures.id', '=', tid).executeTakeFirst()
      if (!row || (row.is_public === 0 && (viewer === null || row.uploader_id !== viewer))) return null
      const [summary] = await summaries(viewer, [row])
      const uploaderRow =
        row.uploader_id === null
          ? undefined
          : await db
              .selectFrom('users')
              .leftJoin('textures as avatar', 'avatar.id', 'users.avatar_texture_id')
              .leftJoin('texture_files as avatarFile', 'avatarFile.hash', 'avatar.hash')
              .select([
                'users.id',
                'users.nickname',
                'avatar.hash',
                'avatar.type',
                'avatarFile.width',
                'avatarFile.height',
              ])
              .where('users.id', '=', row.uploader_id)
              .executeTakeFirst()
      const uploader = uploaderRow
        ? {
            uid: uploaderRow.id,
            nickname: uploaderRow.nickname,
            avatar:
              uploaderRow.hash && uploaderRow.type && uploaderRow.width && uploaderRow.height
                ? {
                    hash: uploaderRow.hash,
                    scale: textureScaleOrNull(uploaderRow.type, uploaderRow.width, uploaderRow.height) ?? 1,
                  }
                : null,
          }
        : null
      let management: TextureDetail['management']
      if (viewer !== null && viewer === row.uploader_id) {
        const values = await settings.read(['score.perKbPublic', 'score.perKbPrivate', 'score.refundOnDelete'])
        const own = await db
          .selectFrom('closet_items')
          .select('score_paid')
          .where('user_id', '=', viewer)
          .where('texture_id', '=', tid)
          .executeTakeFirst()
        management = {
          visibilityDelta:
            storageFee(row.size_bytes!, values[row.is_public === 1 ? 'score.perKbPrivate' : 'score.perKbPublic']) -
            row.score_paid,
          deleteRefund: values['score.refundOnDelete'] ? row.score_paid + (own?.score_paid ?? 0) : 0,
          othersInCloset: await countRows(
            db.selectFrom('closet_items').where('texture_id', '=', tid).where('user_id', '!=', viewer),
          ),
        }
      }
      const item =
        viewer === null
          ? undefined
          : await db
              .selectFrom('closet_items')
              .select(['name', 'score_paid as scorePaid'])
              .where('user_id', '=', viewer)
              .where('texture_id', '=', tid)
              .executeTakeFirst()
      const report =
        viewer === null
          ? undefined
          : await db
              .selectFrom('reports')
              .select('id')
              .where('reporter_id', '=', viewer)
              .where('texture_id', '=', tid)
              .executeTakeFirst()
      return {
        ...summary!,
        uploader,
        // node:sqlite 的行是无原型对象，传不进客户端组件
        closetItem: item ? { name: item.name, scorePaid: item.scorePaid } : null,
        reported: report !== undefined,
        ...(management ? { management } : {}),
      }
    },
  }
}
