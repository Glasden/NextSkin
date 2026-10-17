import type { CoreDatabase, IsoTimestamp } from '@nextskin/db'
import type { Kysely } from 'kysely'

export interface ScoreEntry {
  id: number
  delta: number
  balance: number
  reason: string
  createdAt: IsoTimestamp
}

export function createScoreQueries(db: Kysely<CoreDatabase>) {
  return {
    async recent(uid: number, limit = 10): Promise<ScoreEntry[]> {
      return db
        .selectFrom('score_transactions')
        .select(['id', 'delta', 'balance', 'reason', 'created_at as createdAt'])
        .where('user_id', '=', uid)
        .orderBy('id', 'desc')
        .limit(limit)
        .execute()
    },
  }
}
