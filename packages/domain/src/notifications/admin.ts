import {
  countRows,
  insertReturningId,
  lockForReference,
  toIsoTimestamp,
  transactionWithRetry,
  type CoreDatabase,
  type NotificationAudience,
} from '@nextskin/db'
import { sql, type Kysely } from 'kysely'
import { can } from '../access/permissions.ts'
import { authorize } from '../admin/context.ts'
import { pagination } from '../admin/queries.ts'
import type { AdminActor } from '../admin/types.ts'
import { audit } from '../audit/write.ts'
import { DomainError } from '../errors.ts'
import type { JobRunner } from '../jobs/runner.ts'
import { rejectNul } from '../text.ts'
import { NOTIFICATION_FANOUT_JOB, NOTIFICATION_RECALL_JOB, notificationDedupeKey } from './jobs.ts'

export interface SendNotificationInput {
  audience: NotificationAudience
  recipients?: readonly string[]
  title: string
  body: string
}
export function createAdminNotifications(options: {
  db: Kysely<CoreDatabase>
  jobs: Pick<JobRunner, 'enqueue'>
  now: () => Date
}) {
  const { db, jobs, now } = options
  return {
    async sendNotification(actor: AdminActor, input: SendNotificationInput): Promise<{ id: number }> {
      const title = rejectNul(input.title).trim()
      const body = rejectNul(input.body)
      if ([...title].length < 1 || [...title].length > 60)
        throw new DomainError('notification_title_length', { min: 1, max: 60 }, ['title'])
      if ([...body].length > 5000) throw new DomainError('notification_body_length', { max: 5000 }, ['body'])
      if (!['all', 'users', 'admins', 'specific'].includes(input.audience)) throw new DomainError('invalid_request')
      if (
        input.audience === 'specific' &&
        (!input.recipients || input.recipients.length < 1 || input.recipients.length > 50)
      )
        throw new DomainError('notification_recipients_length', { min: 1, max: 50 }, ['recipients'])
      return transactionWithRetry(db, async (tx) => {
        const eventActor = await authorize(tx, actor, 'notifications.send')
        const at = toIsoTimestamp(now())
        const uids = new Set<number>()
        if (input.audience === 'specific') {
          for (const value of new Set(input.recipients!.map((value) => rejectNul(value).trim()))) {
            const numeric = /^[1-9]\d*$/.test(value)
            const uid = Number(value)
            const user = numeric
              ? Number.isSafeInteger(uid) && uid <= 2147483647
                ? await tx.selectFrom('users').select('id').where('id', '=', uid).executeTakeFirst()
                : undefined
              : await tx.selectFrom('users').select('id').where('email', '=', value.toLowerCase()).executeTakeFirst()
            if (!user) throw new DomainError('notification_recipient_unknown', { value }, ['recipients'])
            uids.add(user.id)
          }
        }
        // 先由 authorize 锁操作者，再创建本次发送。指定收件人用 INSERT SELECT 校验仍存在的用户。
        // specific 的两个水位都记收件人的最大 uid；它不参与展开。
        const through =
          input.audience === 'specific'
            ? Math.max(...uids)
            : ((await tx.selectFrom('users').select('id').orderBy('id', 'desc').limit(1).executeTakeFirst())?.id ?? 0)
        const specific = input.audience === 'specific'
        const id = await insertReturningId(tx, 'notification_broadcasts', {
          sender_id: actor.uid,
          audience: input.audience,
          title,
          body,
          through_uid: through,
          cursor_uid: specific ? through : 0,
          recipient_count: 0,
          status: specific ? 'sent' : 'sending',
          created_at: at,
          finished_at: specific ? at : null,
        })
        if (specific) {
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
                    sql<number>`${id}`.as('broadcast_id'),
                    sql<string>`${at}`.as('created_at'),
                  ])
                  .where('id', 'in', [...uids])
                  .orderBy('id'),
                'users',
              ),
            )
            .executeTakeFirstOrThrow()
          await tx
            .updateTable('notification_broadcasts')
            .set((eb) => ({ recipient_count: eb('recipient_count', '+', Number(result.numInsertedOrUpdatedRows)) }))
            .where('id', '=', id)
            .execute()
        } else
          await jobs.enqueue(
            tx,
            NOTIFICATION_FANOUT_JOB,
            { broadcastId: id },
            { dedupeKey: notificationDedupeKey('fanout', id) },
          )
        await audit(tx, {
          actor: eventActor,
          action: 'notification.send',
          subject: { type: 'notificationBroadcast', id },
          details: { audience: input.audience, ...(specific ? { uids: [...uids].sort((a, b) => a - b) } : {}) },
          ip: actor.ip,
          now: at,
        })
        return { id }
      })
    },
    async listNotificationBroadcasts(actor: AdminActor, input: { page: number }) {
      const user = await db.selectFrom('users').select('role').where('id', '=', actor.uid).executeTakeFirst()
      if (!user || !can(user.role, 'notifications.send')) throw new DomainError('permission_denied')
      const { limit, offset } = pagination(input)
      const rows = await db
        .selectFrom('notification_broadcasts')
        .leftJoin('users', 'users.id', 'notification_broadcasts.sender_id')
        .selectAll('notification_broadcasts')
        .select(['users.id as uid', 'users.nickname'])
        .orderBy('notification_broadcasts.id', 'desc')
        .limit(limit)
        .offset(offset)
        .execute()
      return {
        total: await countRows(db.selectFrom('notification_broadcasts')),
        items: rows.map((row) => ({
          id: row.id,
          sender: row.uid === null ? null : { uid: row.uid, nickname: row.nickname! },
          audience: row.audience,
          title: row.title,
          status: row.status,
          recipientCount: row.recipient_count,
          createdAt: row.created_at,
          finishedAt: row.finished_at,
        })),
      }
    },
    async recallNotification(actor: AdminActor, id: number): Promise<void> {
      await transactionWithRetry(db, async (tx) => {
        const eventActor = await authorize(tx, actor, 'notifications.send')
        // 操作者 -> broadcast。与 fanout 的条件 UPDATE 争同一把行锁，已提交的批次被撤回，下一批立即停止。
        const result = await tx
          .updateTable('notification_broadcasts')
          .set({ status: 'recalled' })
          .where('id', '=', id)
          .where('status', 'in', ['sending', 'sent'])
          .executeTakeFirstOrThrow()
        const row = await tx
          .selectFrom('notification_broadcasts')
          .select('recipient_count')
          .where('id', '=', id)
          .executeTakeFirst()
        if (!row) throw new DomainError('notification_broadcast_not_found')
        if (result.numUpdatedRows === 0n) throw new DomainError('notification_broadcast_recalled')
        await jobs.enqueue(
          tx,
          NOTIFICATION_RECALL_JOB,
          { broadcastId: id },
          { dedupeKey: notificationDedupeKey('recall', id) },
        )
        await audit(tx, {
          actor: eventActor,
          action: 'notification.recall',
          subject: { type: 'notificationBroadcast', id },
          details: { recipientCount: row.recipient_count },
          ip: actor.ip,
          now: toIsoTimestamp(now()),
        })
      })
    },
  }
}
