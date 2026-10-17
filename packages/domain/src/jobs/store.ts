import { randomUUID } from 'node:crypto'
import {
  insertOrIgnore,
  insertReturningId,
  toIsoTimestamp,
  transactionWithRetry,
  type CoreDatabase,
  type IsoTimestamp,
} from '@nextskin/db'
import type { Kysely } from 'kysely'

export const FAILED_JOB_RETENTION_DAYS = 30

export interface NewJob {
  name: string
  payload: unknown
  runAt: IsoTimestamp
  dedupeKey?: string | null
}

export interface ClaimedJob {
  id: number
  name: string
  payload: unknown
  attempts: number
  leaseId: string
  createdAt: IsoTimestamp
}

export async function insertJob(db: Kysely<CoreDatabase>, job: NewJob, now: IsoTimestamp): Promise<boolean> {
  // MySQL 的 utf8mb4_bin 比较时忽略末尾空格，PG 和 SQLite 不会：首尾带空白的键在四种数据库上去重结果不同
  const nameLength = [...job.name].length
  if (nameLength < 1 || nameLength > 128 || job.name !== job.name.trim())
    throw new RangeError('任务名长度必须在 1 到 128 个字符之间，首尾不能有空白')
  if (
    job.dedupeKey != null &&
    ([...job.dedupeKey].length < 1 || [...job.dedupeKey].length > 255 || job.dedupeKey !== job.dedupeKey.trim())
  ) {
    throw new RangeError('任务去重键长度必须在 1 到 255 个字符之间，首尾不能有空白')
  }
  return insertOrIgnore(
    db,
    'jobs',
    {
      name: job.name,
      payload: JSON.stringify(job.payload),
      dedupe_key: job.dedupeKey ?? null,
      run_at: job.runAt,
      created_at: now,
    },
    ['name', 'dedupe_key'],
  )
}

export async function findDueJobs(
  db: Kysely<CoreDatabase>,
  options: { names: readonly string[]; now: IsoTimestamp; limit: number },
): Promise<{ id: number; name: string }[]> {
  if (options.names.length === 0) return []
  return db
    .selectFrom('jobs')
    .select(['id', 'name'])
    .where('run_at', '<=', options.now)
    .where('name', 'in', options.names)
    .orderBy('run_at')
    .orderBy('id')
    .limit(options.limit)
    .execute()
}

export async function claimJob(
  db: Kysely<CoreDatabase>,
  options: { id: number; now: IsoTimestamp; leaseUntil: IsoTimestamp },
): Promise<ClaimedJob | null> {
  const claim = async (tx: Kysely<CoreDatabase>): Promise<ClaimedJob | null> => {
    const leaseId = randomUUID()
    const result = await tx
      .updateTable('jobs')
      .set((eb) => ({
        run_at: options.leaseUntil,
        lease_id: leaseId,
        attempts: eb('attempts', '+', 1),
      }))
      .where('id', '=', options.id)
      .where('run_at', '<=', options.now)
      .executeTakeFirstOrThrow()
    if (result.numUpdatedRows === 0n) return null
    const row = await tx
      .selectFrom('jobs')
      .selectAll()
      .where('id', '=', options.id)
      .where('lease_id', '=', leaseId)
      .executeTakeFirstOrThrow()
    return {
      id: row.id,
      name: row.name,
      payload: JSON.parse(row.payload) as unknown,
      attempts: row.attempts,
      leaseId,
      createdAt: row.created_at,
    }
  }
  return db.isTransaction ? claim(db) : transactionWithRetry(db, claim)
}

export async function completeJob(db: Kysely<CoreDatabase>, lease: { id: number; leaseId: string }): Promise<boolean> {
  const result = await db
    .deleteFrom('jobs')
    .where('id', '=', lease.id)
    .where('lease_id', '=', lease.leaseId)
    .executeTakeFirstOrThrow()
  return result.numDeletedRows > 0n
}

export async function rescheduleJob(
  db: Kysely<CoreDatabase>,
  lease: { id: number; leaseId: string },
  options: { runAt: IsoTimestamp; error: string },
): Promise<boolean> {
  const result = await db
    .updateTable('jobs')
    .set({
      run_at: options.runAt,
      lease_id: null,
      last_error: [...options.error].slice(0, 500).join(''),
    })
    .where('id', '=', lease.id)
    .where('lease_id', '=', lease.leaseId)
    .executeTakeFirstOrThrow()
  return result.numUpdatedRows > 0n
}

export async function failJob(
  db: Kysely<CoreDatabase>,
  lease: { id: number; leaseId: string },
  options: { error: string; now: IsoTimestamp; payload?: unknown },
): Promise<boolean> {
  const fail = async (tx: Kysely<CoreDatabase>): Promise<boolean> => {
    const row = await tx
      .selectFrom('jobs')
      .selectAll()
      .where('id', '=', lease.id)
      .where('lease_id', '=', lease.leaseId)
      .executeTakeFirst()
    if (!row) return false
    const failedId = await insertReturningId(tx, 'failed_jobs', {
      name: row.name,
      payload: 'payload' in options ? JSON.stringify(options.payload) : row.payload,
      dedupe_key: row.dedupe_key,
      attempts: row.attempts,
      last_error: [...options.error].slice(0, 500).join(''),
      created_at: row.created_at,
      failed_at: options.now,
    })
    // READ COMMITTED 下读出后可能被重新认领；删除时再次核验租约，并撤回本次死信。
    if (!(await completeJob(tx, lease))) {
      await tx.deleteFrom('failed_jobs').where('id', '=', failedId).execute()
      return false
    }
    const cutoff = toIsoTimestamp(new Date(Date.parse(options.now) - FAILED_JOB_RETENTION_DAYS * 86_400_000))
    await tx.deleteFrom('failed_jobs').where('failed_at', '<', cutoff).execute()
    return true
  }
  return db.isTransaction ? fail(db) : transactionWithRetry(db, fail)
}
