// reports → reports（docs/schema.md 的对照表）
import { countRows, type ReportsTable } from '@nextskin/db'
import type { Insertable } from 'kysely'
import { chunks, existingUsers, importedTextures, MAX_ID, pages, type StageContext } from '../context.ts'
import { bump } from '../report.ts'
import { bsDateTime, toInt, toText } from '../values.ts'

const STATUSES: Record<number, 'pending' | 'resolved' | 'rejected'> = { 0: 'pending', 1: 'resolved', 2: 'rejected' }

export async function importReports(ctx: StageContext): Promise<void> {
  const { src, tx, report } = ctx
  const stats = report.tables.reports
  const table = ctx.schema.tables.reports
  stats.source = await countRows(src.selectFrom(table))
  // 同一个人对同一个材质的重复举报只保留 id 最小的一条，按旧库里的原值判断：材质或举报人已经不存在的也算，
  // 否则材质被删掉的重复举报会各自结案、各退一次花费
  const seen = new Set<string>()
  const cost = ctx.rules.reporterScoreModification < 0 ? -ctx.rules.reporterScoreModification : 0
  for await (const rows of pages(src, table, 'id', [
    'id',
    'tid',
    'uploader',
    'reporter',
    'reason',
    'status',
    'report_at',
  ])) {
    const parsed = rows
      .map((row) => ({
        id: toInt(row.id)!,
        tid: toInt(row.tid) ?? 0,
        uploader: toInt(row.uploader) ?? 0,
        reporter: toInt(row.reporter) ?? 0,
        reason: toText(row.reason) ?? '',
        status: toInt(row.status),
        reportedAt: row.report_at,
      }))
      .filter((row) => row.id <= MAX_ID)
    const users = await existingUsers(
      tx,
      parsed.flatMap((row) => [row.uploader, row.reporter]),
    )
    const textures = await importedTextures(
      tx,
      parsed.map((row) => row.tid),
    )
    const values: Insertable<ReportsTable>[] = []
    const refunds = new Map<number, number>()
    for (const row of parsed) {
      const status = row.status === null ? undefined : STATUSES[row.status]
      if (!status) {
        bump(stats.skipped, 'invalid_status')
        continue
      }
      const key = `${row.reporter}:${row.tid}`
      if (seen.has(key)) {
        report.reports.duplicates++
        bump(stats.skipped, 'duplicate')
        continue
      }
      seen.add(key)
      const textureId = textures.has(row.tid) ? row.tid : null
      const reporterId = users.has(row.reporter) ? row.reporter : null
      if (textureId === null && row.tid > 0) bump(stats.adjusted, 'texture_missing')
      if (reporterId === null) bump(stats.adjusted, 'reporter_missing')
      let reportedAt = bsDateTime(row.reportedAt, ctx.timeZone)
      if (!reportedAt) {
        reportedAt = ctx.now
        bump(stats.adjusted, 'invalid_report_at')
      }
      const value: Insertable<ReportsTable> = {
        id: row.id,
        texture_id: textureId,
        uploader_id: users.has(row.uploader) ? row.uploader : null,
        reporter_id: reporterId,
        reason: row.reason,
        // 举报时实际付的花费，采纳时按它退还（ADR-0026）
        score_paid: status === 'pending' ? cost : 0,
        status,
        resolution: null,
        resolver_id: null,
        created_at: reportedAt,
        resolved_at: null,
      }
      // 材质已经不存在的待处理举报记为已结案，花费直接加回举报人导入的积分：待处理的举报总是指向存在的材质（ADR-0027）
      if (status === 'pending' && textureId === null) {
        if (reporterId !== null && cost > 0) {
          refunds.set(reporterId, (refunds.get(reporterId) ?? 0) + cost)
          report.reports.refunded += cost
        }
        Object.assign(value, {
          status: 'resolved',
          resolution: 'textureDeleted',
          resolved_at: ctx.now,
          score_paid: 0,
        })
        report.reports.autoResolved++
      }
      values.push(value)
    }
    for (const part of chunks(values, 200)) await tx.insertInto('reports').values(part).execute()
    // 按 uid 升序加回积分（schema.md 的加锁顺序；这里只有导入器一个写入方，保持同样的顺序）。流水在所有阶段之后才写
    for (const [uid, amount] of [...refunds].sort(([a], [b]) => a - b))
      await tx
        .updateTable('users')
        .set((eb) => ({ score: eb('score', '+', amount) }))
        .where('id', '=', uid)
        .execute()
    stats.imported += values.length
    ctx.advance('reports', rows.length)
  }
}
