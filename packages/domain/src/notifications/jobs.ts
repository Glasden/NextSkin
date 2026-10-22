import {
  lockForReference,
  toIsoTimestamp,
  transactionWithRetry,
  type CoreDatabase,
  type NotificationAudience,
  type UserRole,
} from '@nextskin/db'
import { sql, type Kysely, type Transaction } from 'kysely'
import { z } from 'zod'
import { hasAdminAccess } from '../access/permissions.ts'
import type { JobHandler, JobRunner } from '../jobs/runner.ts'
import type { createSettingQueries } from '../settings/queries.ts'

export const NOTIFICATION_FANOUT_JOB = 'core:notification-fanout'
export const NOTIFICATION_RECALL_JOB = 'core:notification-recall'
export const NOTIFICATION_SWEEP_JOB = 'core:notification-sweep'
export const notificationDedupeKey = (kind: 'fanout' | 'recall', id: number) => `notification-${kind}:${id}`
const payloadSchema = z.object({ broadcastId: z.int().positive().max(2147483647) })
/** 收件人类型对应的身份。管理员按能不能进后台算，不借用某一项权限：权限以后调整，收件范围不该跟着变 */
export function audienceRoles(audience: NotificationAudience): UserRole[] {
  const admins = (['admin', 'superadmin'] as const).filter(hasAdminAccess)
  if (audience === 'users') return ['user']
  if (audience === 'admins') return admins
  return ['user', ...admins]
}
export function createNotificationJobs(options: {
  db: Kysely<CoreDatabase>
  jobs: Pick<JobRunner, 'enqueue'>
  settings: Pick<ReturnType<typeof createSettingQueries>, 'read'>
  now: () => Date
  /** 测试可缩短预算；生产默认 20 秒，给超时和事务重试留余量。 */
  budgetMs?: number
}): Record<string, JobHandler> {
  const { db, jobs, settings, now } = options
  const budgetMs = options.budgetMs ?? 20_000
  async function continueJob(
    tx: Transaction<CoreDatabase>,
    jobId: number,
    kind: 'fanout' | 'recall',
    broadcastId: number,
  ) {
    await tx.updateTable('jobs').set({ dedupe_key: null }).where('id', '=', jobId).execute()
    await jobs.enqueue(
      tx,
      kind === 'fanout' ? NOTIFICATION_FANOUT_JOB : NOTIFICATION_RECALL_JOB,
      { broadcastId },
      { dedupeKey: notificationDedupeKey(kind, broadcastId) },
    )
  }
  return {
    [NOTIFICATION_FANOUT_JOB]: {
      concurrency: 1,
      timeoutMs: 120_000,
      retryable: (payload) => payloadSchema.safeParse(payload).success,
      async run({ jobId, payload, signal }) {
        const { broadcastId } = payloadSchema.parse(payload)
        const started = now().getTime()
        for (;;) {
          signal.throwIfAborted()
          const done = await transactionWithRetry(db, async (tx) => {
            // 每批先锁 broadcast，再从仍存在的 users 写收件行；撤回也先锁 broadcast，双方不会交错推进状态。
            const locked = await tx
              .updateTable('notification_broadcasts')
              .set({ status: 'sending' })
              .where('id', '=', broadcastId)
              .where('status', '=', 'sending')
              .executeTakeFirstOrThrow()
            if (locked.numUpdatedRows === 0n) return true
            const row = await tx
              .selectFrom('notification_broadcasts')
              .selectAll()
              .where('id', '=', broadcastId)
              .executeTakeFirstOrThrow()
            // 不按身份过滤扫描：一整批被封禁也必须推进游标。
            const users = await tx
              .selectFrom('users')
              .select('id')
              .where('id', '>', row.cursor_uid)
              .where('id', '<=', row.through_uid)
              .orderBy('id')
              .limit(500)
              .execute()
            let inserted = 0
            if (users.length) {
              const result = await tx
                .insertInto('notifications')
                .columns(['user_id', 'type', 'broadcast_id', 'created_at'])
                .expression(
                  lockForReference(
                    tx,
                    tx
                      .selectFrom('users')
                      .select([
                        'id as user_id',
                        sql<string>`${'message'}`.as('type'),
                        sql<number>`${broadcastId}`.as('broadcast_id'),
                        sql<string>`${row.created_at}`.as('created_at'),
                      ])
                      .where(
                        'id',
                        'in',
                        users.map((user) => user.id),
                      )
                      .where('role', 'in', audienceRoles(row.audience))
                      .orderBy('id'),
                    'users',
                  ),
                )
                .executeTakeFirstOrThrow()
              inserted = Number(result.numInsertedOrUpdatedRows)
            }
            const finished = users.length < 500
            await tx
              .updateTable('notification_broadcasts')
              .set((eb) => ({
                cursor_uid: users.at(-1)?.id ?? row.through_uid,
                recipient_count: eb('recipient_count', '+', inserted),
                ...(finished ? { status: 'sent' as const, finished_at: toIsoTimestamp(now()) } : {}),
              }))
              .where('id', '=', broadcastId)
              .execute()
            if (finished) return true
            if (now().getTime() - started >= budgetMs) {
              await continueJob(tx, jobId, 'fanout', broadcastId)
              return true
            }
            return false
          })
          if (done) return
        }
      },
    },
    [NOTIFICATION_RECALL_JOB]: {
      concurrency: 1,
      timeoutMs: 120_000,
      retryable: (payload) => payloadSchema.safeParse(payload).success,
      async run({ jobId, payload, signal }) {
        const { broadcastId } = payloadSchema.parse(payload)
        const started = now().getTime()
        for (;;) {
          signal.throwIfAborted()
          const done = await transactionWithRetry(db, async (tx) => {
            // 与 fanout 同样先锁 broadcast；只清理已撤回的发送，误投的任务也不能删除有效通知。
            const locked = await tx
              .updateTable('notification_broadcasts')
              .set({ status: 'recalled' })
              .where('id', '=', broadcastId)
              .where('status', '=', 'recalled')
              .executeTakeFirstOrThrow()
            if (locked.numUpdatedRows === 0n) return true
            const rows = await tx
              .selectFrom('notifications')
              .select('id')
              .where('broadcast_id', '=', broadcastId)
              .orderBy('id')
              .limit(1000)
              .execute()
            if (rows.length)
              await tx
                .deleteFrom('notifications')
                .where(
                  'id',
                  'in',
                  rows.map((row) => row.id),
                )
                .execute()
            if (rows.length < 1000) return true
            if (now().getTime() - started >= budgetMs) {
              await continueJob(tx, jobId, 'recall', broadcastId)
              return true
            }
            return false
          })
          if (done) return
        }
      },
    },
    [NOTIFICATION_SWEEP_JOB]: {
      concurrency: 1,
      timeoutMs: 600_000,
      async run({ signal }) {
        const days = (await settings.read(['notifications.retentionDays']))['notifications.retentionDays']
        if (days === 0) return
        const cutoff = toIsoTimestamp(new Date(now().getTime() - days * 86_400_000))
        for (;;) {
          signal.throwIfAborted()
          const done = await transactionWithRetry(db, async (tx) => {
            const rows = await tx
              .selectFrom('notifications')
              .select(['id', 'created_at'])
              .orderBy('id')
              .limit(1000)
              .execute()
            const expired = rows.filter((row) => row.created_at < cutoff)
            if (expired.length)
              await tx
                .deleteFrom('notifications')
                .where(
                  'id',
                  'in',
                  expired.map((row) => row.id),
                )
                .execute()
            return rows.length < 1000 || expired.length !== rows.length
          })
          if (done) break
        }
        for (;;) {
          signal.throwIfAborted()
          const done = await transactionWithRetry(db, async (tx) => {
            const rows = await tx
              .selectFrom('notification_broadcasts')
              .select('id')
              .where('created_at', '<', cutoff)
              .where('status', 'in', ['sent', 'recalled'])
              .orderBy('id')
              .limit(1000)
              .execute()
            if (rows.length)
              await tx
                .deleteFrom('notification_broadcasts')
                .where(
                  'id',
                  'in',
                  rows.map((row) => row.id),
                )
                .where('status', 'in', ['sent', 'recalled'])
                .execute()
            return rows.length < 1000
          })
          if (done) return
        }
      },
    },
  }
}
