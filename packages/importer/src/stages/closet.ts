// user_closet → closet_items：表上没有主键，重复的行只留一条；用户或材质不存在时跳过
import { countRows } from '@nextskin/db'
import { chunks, existingUsers, importedTextures, MAX_ID, PAGE_SIZE, type StageContext } from '../context.ts'
import { bump } from '../report.ts'
import { toInt, toText } from '../values.ts'

export async function importCloset(ctx: StageContext): Promise<void> {
  const { src, tx, report } = ctx
  const stats = report.tables.closet
  const table = ctx.schema.tables.user_closet
  stats.source = await countRows(src.selectFrom(table))
  let distinct = 0
  let last: { uid: number; tid: number } | null = null
  // 按 (user_uid, texture_tid) 分页：同一对的重复行在排序后相邻，翻页条件用严格大于，每一对只读到一次
  for (;;) {
    let query = src
      .selectFrom(table)
      .select(['user_uid', 'texture_tid', 'item_name'] as never)
      .orderBy('user_uid')
      .orderBy('texture_tid')
      .limit(PAGE_SIZE)
    if (last) {
      const { uid, tid } = last
      query = query.where((eb) =>
        eb.or([eb('user_uid', '>', uid), eb.and([eb('user_uid', '=', uid), eb('texture_tid', '>', tid)])]),
      )
    }
    const rows = (await query.execute()) as Record<string, unknown>[]
    if (!rows.length) break
    const items: { uid: number; tid: number; name: string | null }[] = []
    for (const row of rows) {
      const uid = toInt(row.user_uid)
      const tid = toInt(row.texture_tid)
      if (uid === null || tid === null) throw new Error('旧库 user_closet 的 user_uid、texture_tid 不是整数')
      if (items.at(-1)?.uid === uid && items.at(-1)?.tid === tid) continue
      items.push({ uid, tid, name: toText(row.item_name) })
    }
    const lastRow = items.at(-1)!
    last = { uid: lastRow.uid, tid: lastRow.tid }
    distinct += items.length
    const users = await existingUsers(
      tx,
      items.map((item) => item.uid).filter((uid) => uid > 0 && uid <= MAX_ID),
    )
    const textures = await importedTextures(
      tx,
      items.map((item) => item.tid),
    )
    const values = []
    for (const item of items) {
      const texture = textures.get(item.tid)
      if (!users.has(item.uid)) bump(stats.skipped, 'user_missing')
      else if (!texture) bump(stats.skipped, 'texture_missing')
      else
        values.push({
          user_id: item.uid,
          texture_id: item.tid,
          name: item.name?.trim() ? item.name : texture.name,
          // BS 移出任何一件都按现价退还（ADR-0025）
          score_paid: Math.max(0, Math.min(MAX_ID, ctx.rules.scorePerClosetItem)),
          // BS 没有记录加入时间
          created_at: ctx.now,
        })
    }
    for (const part of chunks(values, 200)) await tx.insertInto('closet_items').values(part).execute()
    stats.imported += values.length
    ctx.advance('closet', rows.length)
    if (rows.length < PAGE_SIZE) break
  }
  report.closet.duplicates = stats.source - distinct
  if (report.closet.duplicates) bump(stats.skipped, 'duplicate', report.closet.duplicates)
}
