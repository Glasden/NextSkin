import type { CoreDatabase, IsoTimestamp } from '@nextskin/db'
import type { Kysely, Transaction } from 'kysely'
import type { ImportReport, UuidSource } from './report.ts'
import type { BsRules } from './settings.ts'
import type { SourceDatabase, SourceSchema } from './source/schema.ts'

/** NextSkin 的主键是有符号 integer（ADR-0015） */
export const MAX_ID = 2147483647
/** 每页从旧库读的行数，也是写入的批大小上限的来源 */
export const PAGE_SIZE = 500

export type ImportStage =
  'connect' | 'users' | 'textures' | 'players' | 'closet' | 'reports' | 'oauthClients' | 'settings' | 'commit'

export interface ImportProgress {
  stage: ImportStage
  /** 这一阶段已经处理的行数 */
  rows: number
  /** 已经处理的材质文件数 */
  files: number
}

export class ImportCancelledError extends Error {
  constructor() {
    super('导入已取消')
    this.name = 'ImportCancelledError'
  }
}

export interface StageContext {
  src: Kysely<SourceDatabase>
  tx: Transaction<CoreDatabase>
  schema: SourceSchema
  report: ImportReport
  rules: BsRules
  timeZone: string
  /** 导入时刻：BS 没有记录的时间（衣柜的加入时间、自动结案的举报）都用它 */
  now: IsoTimestamp
  /** 处理完一批之后调用：检查取消信号，报告进度 */
  advance(stage: ImportStage, rows: number, files?: number): void
  /** 每个导入的角色的 UUID 和来源，报告里只放得下统计和一部分，完整的列表由调用方写进文件 */
  onPlayerUuid?: (entry: PlayerUuid) => void
}

export interface PlayerUuid {
  pid: number
  name: string
  uuid: string
  source: UuidSource
}

/** 按整数主键分页读整张表，每页 PAGE_SIZE 行。翻页条件用旧库读出来的原值：超过 2^53 的 bigint 读成字符串或 bigint */
export async function* pages(
  src: Kysely<SourceDatabase>,
  table: string,
  key: string,
  columns: readonly string[],
): AsyncGenerator<Record<string, unknown>[]> {
  let last: unknown = null
  for (;;) {
    let query = src
      .selectFrom(table)
      .select(columns as never)
      .orderBy(key)
      .limit(PAGE_SIZE)
    if (last !== null) query = query.where(key, '>', last as never)
    const rows = (await query.execute()) as Record<string, unknown>[]
    if (!rows.length) return
    yield rows
    last = rows.at(-1)![key]
    if (last === null || last === undefined) throw new Error(`旧库 ${table}.${key} 有空值`)
    if (rows.length < PAGE_SIZE) return
  }
}

export function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size))
  return result
}

/** 目标库里已经导入的行（同一个事务里），用来判断引用是否还在 */
export async function existingUsers(tx: Transaction<CoreDatabase>, ids: Iterable<number>): Promise<Set<number>> {
  const unique = [...new Set(ids)]
  const found = new Set<number>()
  for (const part of chunks(unique, PAGE_SIZE)) {
    if (!part.length) continue
    for (const row of await tx.selectFrom('users').select('id').where('id', 'in', part).execute()) found.add(row.id)
  }
  return found
}

export interface ImportedTexture {
  name: string
  hash: string
  type: 'steve' | 'alex' | 'cape'
}

export async function importedTextures(
  tx: Transaction<CoreDatabase>,
  ids: Iterable<number>,
): Promise<Map<number, ImportedTexture>> {
  const unique = [...new Set(ids)].filter((id) => id > 0 && id <= MAX_ID)
  const found = new Map<number, ImportedTexture>()
  for (const part of chunks(unique, PAGE_SIZE)) {
    if (!part.length) continue
    const rows = await tx
      .selectFrom('textures')
      .select(['id', 'name', 'hash', 'type'])
      .where('id', 'in', part)
      .execute()
    for (const row of rows) found.set(row.id, { name: row.name, hash: row.hash, type: row.type })
  }
  return found
}
