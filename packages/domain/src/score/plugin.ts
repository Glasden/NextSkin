import { isUniqueViolation, transactionWithRetry, type CoreDatabase, type IsoTimestamp } from '@nextskin/db'
import type { Kysely } from 'kysely'
import { DomainError } from '../errors.ts'
import { PluginCallRejected } from '../plugins/errors.ts'
import { adjustScore, ScoreUserMissingError } from './adjust.ts'

export interface PluginScoreAdjustment {
  pluginId: string
  key: string
  uid: number
  delta: number
  reason: string
  now: IsoTimestamp
}

export interface PluginScoreResult {
  status: 'applied' | 'duplicate' | 'insufficient' | 'userNotFound'
  balance: number | null
}

/** 输入由插件 RPC 校验；积分与永久幂等键在同一事务里提交，不写审计、不发事件（ADR-0041）。 */
export async function adjustPluginScore(
  db: Kysely<CoreDatabase>,
  input: PluginScoreAdjustment,
): Promise<PluginScoreResult> {
  const { pluginId, key, uid, delta, reason, now } = input
  async function duplicate(executor: Kysely<CoreDatabase>): Promise<PluginScoreResult | undefined> {
    const entry = await executor
      .selectFrom('score_transactions')
      .innerJoin('users', 'users.id', 'score_transactions.user_id')
      .select(['score_transactions.user_id', 'score_transactions.delta', 'users.score'])
      .where('plugin_id', '=', pluginId)
      .where('plugin_key', '=', key)
      .executeTakeFirst()
    if (!entry) return undefined
    if (entry.user_id !== uid || entry.delta !== delta)
      throw new PluginCallRejected('同一个 key 已经用于另一笔积分变动')
    return { status: 'duplicate', balance: entry.score }
  }
  try {
    return await transactionWithRetry(db, async (tx): Promise<PluginScoreResult> => {
      const replay = await duplicate(tx)
      if (replay) return replay
      // 主键为 int32；更大的安全整数同样是合法但不存在的 uid，避免 PG 将参数绑定为 integer 后溢出。
      if (uid > 2147483647) return { status: 'userNotFound', balance: null }
      const user = await tx.selectFrom('users').select('score').where('id', '=', uid).executeTakeFirst()
      if (!user) return { status: 'userNotFound', balance: null }
      const { score } = await adjustScore(tx, { uid, delta, reason, now, plugin: { id: pluginId, key } })
      return { status: 'applied', balance: score }
    })
  } catch (error) {
    // 唯一冲突不属于 transactionWithRetry 的重试范围；到这里时整个事务已回滚。
    const insufficient = error instanceof DomainError && error.code === 'score_insufficient'
    // 同 key 的扣分或加到上限也可能先撞余额条件；回滚后识别已提交的那一笔。
    if (isUniqueViolation(db, error) || insufficient || error instanceof RangeError) {
      const replay = await duplicate(db)
      if (replay) return replay
    }
    // 预查之后、改余额之前用户被并发删除
    if (error instanceof ScoreUserMissingError) return { status: 'userNotFound', balance: null }
    if (insufficient) return { status: 'insufficient', balance: Number(error.params!.balance) }
    if (error instanceof RangeError) throw new PluginCallRejected(error.message)
    throw error
  }
}
