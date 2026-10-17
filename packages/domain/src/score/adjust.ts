import type { CoreDatabase, IsoTimestamp } from '@nextskin/db'
import { sql, type Kysely } from 'kysely'
import { DomainError } from '../errors.ts'

export interface ScoreAdjustment {
  uid: number
  delta: number
  reason: string
  subject?: { type: string; id: number } | null
  now: IsoTimestamp
}

export async function adjustScore(tx: Kysely<CoreDatabase>, adjustment: ScoreAdjustment): Promise<{ score: number }> {
  if (!tx.isTransaction) throw new TypeError('积分调整必须在调用方的事务中执行')
  const { uid, delta, reason, subject, now } = adjustment
  if (!Number.isSafeInteger(delta) || delta === 0) throw new RangeError('积分变动必须是非零安全整数')
  if ([...reason].length < 1 || [...reason].length > 128) throw new RangeError('积分原因长度必须在 1 到 128 个字符之间')
  // 已校验为安全整数的数值用 SQL 字面量，避免 PG 把超过 int32 的失败条件参数绑定为 integer。
  let update = tx
    .updateTable('users')
    .set((eb) => ({ score: eb('score', '+', sql.lit(delta)) }))
    .where('id', '=', uid)
  update =
    delta < 0 ? update.where('score', '>=', sql.lit(-delta)) : update.where('score', '<=', sql.lit(2147483647 - delta))
  const result = await update.executeTakeFirstOrThrow()
  const user = await tx.selectFrom('users').select('score').where('id', '=', uid).executeTakeFirst()
  if (!user) throw new Error('积分调整引用了不存在的用户')
  if (result.numUpdatedRows === 0n) {
    if (delta < 0) throw new DomainError('score_insufficient', { required: -delta, balance: user.score })
    throw new RangeError('积分余额超过整数上限')
  }
  await tx
    .insertInto('score_transactions')
    .values({
      user_id: uid,
      delta,
      balance: user.score,
      reason,
      subject_type: subject?.type ?? null,
      subject_id: subject?.id ?? null,
      created_at: now,
    })
    .execute()
  return user
}
