import { countRows, toIsoTimestamp, toNumber, type CoreDatabase } from '@nextskin/db'
import { sql, type Kysely } from 'kysely'
import { textureScaleOrNull } from '../players/queries.ts'
import type { createSettingQueries } from '../settings/queries.ts'
import { localDate, todayStart } from '../time.ts'

export interface PodiumEntry {
  tid: number
  name: string
  type: 'steve' | 'alex'
  hash: string
  scale: number
  gain: number
}
export interface Podium {
  from: string
  to: string
  entries: PodiumEntry[]
}
export interface SiteStats {
  textures: number
  users: number
  players: number
}

export function createHomeQueries(
  db: Kysely<CoreDatabase>,
  settings: ReturnType<typeof createSettingQueries>,
  now: () => Date,
) {
  let podiumCache: { value: Podium; expires: number } | undefined
  let statsCache: { value: SiteStats; expires: number } | undefined
  return {
    async podium(): Promise<Podium> {
      const current = now()
      if (podiumCache && current.getTime() < podiumCache.expires) return podiumCache.value
      const values = await settings.read(['site.timeZone'])
      const timeZone = values['site.timeZone']
      const start = todayStart(current, timeZone, 6)
      // 先按时间区间取最近 7 天的衣柜行（走 created_at 的索引），再关联材质。子查询带 GROUP BY，四种数据库都不会
      // 把它展开进外层的关联，计划就固定成"先按时间缩小范围"，不会改成扫全部公开材质再逐个查衣柜。
      // 主键是 (user_id, texture_id)，每组只有一行；保留 user_id 是为了在外层排除上传者自己的那一件（ADR-0032）
      const recent = db
        .selectFrom('closet_items')
        .where('created_at', '>=', start)
        .where('created_at', '<=', toIsoTimestamp(current))
        .select(['texture_id', 'user_id'])
        .select((eb) => eb.fn.sum(sql.lit(1)).as('gain'))
        .groupBy(['texture_id', 'user_id'])
        .as('recent')
      const rows = await db
        .selectFrom(recent)
        .innerJoin('textures', 'textures.id', 'recent.texture_id')
        .innerJoin('texture_files', 'texture_files.hash', 'textures.hash')
        .where('textures.is_public', '=', 1)
        .where('textures.type', 'in', ['steve', 'alex'])
        .where((eb) =>
          eb.or([eb('textures.uploader_id', 'is', null), eb('recent.user_id', '!=', eb.ref('textures.uploader_id'))]),
        )
        .select([
          'textures.id',
          'textures.name',
          'textures.type',
          'textures.hash',
          'texture_files.width',
          'texture_files.height',
        ])
        .select((eb) => eb.fn.sum('recent.gain').as('gain'))
        .groupBy([
          'textures.id',
          'textures.name',
          'textures.type',
          'textures.hash',
          'textures.likes',
          'texture_files.width',
          'texture_files.height',
        ])
        .orderBy('gain', 'desc')
        .orderBy('textures.likes', 'desc')
        .orderBy('textures.id', 'desc')
        .limit(3)
        .execute()
      const value: Podium = {
        from: localDate(new Date(start), timeZone),
        to: localDate(current, timeZone),
        entries: rows.map((row) => ({
          tid: row.id,
          name: row.name,
          type: row.type as 'steve' | 'alex',
          hash: row.hash,
          scale: textureScaleOrNull(row.type, row.width, row.height) ?? 1,
          gain: toNumber(row.gain),
        })),
      }
      podiumCache = { value, expires: current.getTime() + 60000 }
      return value
    },
    async stats(): Promise<SiteStats> {
      const current = now().getTime()
      if (statsCache && current < statsCache.expires) return statsCache.value
      const value = {
        textures: await countRows(db.selectFrom('textures').where('is_public', '=', 1)),
        users: await countRows(db.selectFrom('users')),
        players: await countRows(db.selectFrom('players')),
      }
      statsCache = { value, expires: current + 60000 }
      return value
    },
  }
}
