import type { CoreDatabase, IsoTimestamp } from '@nextskin/db'
import type { Actor } from '@nextskin/plugin-sdk'
import type { Selectable, Transaction } from 'kysely'
import { audit } from '../audit/write.ts'
import type { Events } from '../events/emit.ts'
import { adjustScore } from '../score/adjust.ts'
import type { ReportAction } from './types.ts'

const resolutions = { dismiss: 'dismissed', deleteTexture: 'textureDeleted', banUploader: 'uploaderBanned' } as const
export async function claimReport(
  tx: Transaction<CoreDatabase>,
  id: number,
  action: ReportAction,
  resolver: number | null,
  now: IsoTimestamp,
) {
  const result = await tx
    .updateTable('reports')
    .set({
      status: action === 'dismiss' ? 'rejected' : 'resolved',
      resolution: resolutions[action],
      resolver_id: resolver,
      resolved_at: now,
    })
    .where('id', '=', id)
    .where('status', '=', 'pending')
    .executeTakeFirstOrThrow()
  return result.numUpdatedRows === 0n
    ? null
    : tx.selectFrom('reports').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
}
/** 调用方已经推进状态；退款、事件和审计仍在同一个事务里。 */
export async function settleReport(
  tx: Transaction<CoreDatabase>,
  events: Events,
  row: Selectable<CoreDatabase['reports']>,
  input: {
    actor: Actor
    action: ReportAction
    reward: number
    ip: string | null
    management: boolean
    deletedAccountUid?: number
    now: IsoTimestamp
  },
): Promise<void> {
  const { actor, action, now } = input
  let refunded = 0,
    rewarded = 0
  if (action !== 'dismiss' && row.reporter_id !== null && row.reporter_id !== input.deletedAccountUid) {
    // 举报人可能在预读后注销；先锁住仍存在的用户，再结算。
    await tx
      .updateTable('users')
      .set((eb) => ({ role: eb.ref('role') }))
      .where('id', '=', row.reporter_id)
      .execute()
    const reporter = await tx.selectFrom('users').select('id').where('id', '=', row.reporter_id).executeTakeFirst()
    if (reporter) {
      const subject = { type: 'report', id: row.id }
      refunded = row.score_paid
      rewarded = input.reward
      if (refunded > 0)
        await adjustScore(tx, {
          uid: reporter.id,
          delta: refunded,
          reason: 'score.reasons.reportRefunded',
          subject,
          now,
        })
      if (rewarded > 0)
        await adjustScore(tx, {
          uid: reporter.id,
          delta: rewarded,
          reason: 'score.reasons.reportRewarded',
          subject,
          now,
        })
    }
  }
  if (row.texture_id === null) throw new TypeError('待处理举报必须指向存在的材质')
  await events.emit(
    tx,
    'report.resolved',
    actor,
    { reportId: row.id, tid: row.texture_id, action: resolutions[action] },
    now,
  )
  if (input.management)
    await audit(tx, {
      actor,
      action: 'report.resolve',
      subject: { type: 'report', id: row.id },
      details: { action, tid: row.texture_id, refunded, rewarded },
      ip: input.ip,
      now,
    })
}
