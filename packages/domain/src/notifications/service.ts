import { countRows, toIsoTimestamp, transactionWithRetry, type CoreDatabase } from '@nextskin/db'
import type { Locale } from '@nextskin/i18n'
import type { Kysely } from 'kysely'
import { DomainError } from '../errors.ts'
import { lockUser } from '../users/lock.ts'
import { renderNotification, type NotificationPlugins } from './render.ts'

/** 撤回立即隐藏：分批删除完成前，列表、摘要和未读计数都只看有效的群发。 */
function visible(db: Kysely<CoreDatabase>, uid: number) {
  return db
    .selectFrom('notifications')
    .leftJoin('notification_broadcasts', 'notification_broadcasts.id', 'notifications.broadcast_id')
    .where('notifications.user_id', '=', uid)
    .where((eb) =>
      eb.or([eb('notifications.broadcast_id', 'is', null), eb('notification_broadcasts.status', '!=', 'recalled')]),
    )
}
export function createNotifications(options: {
  db: Kysely<CoreDatabase>
  plugins: NotificationPlugins
  now: () => Date
}) {
  const { db, plugins, now } = options
  async function requireUser(uid: number) {
    const user = await db.selectFrom('users').select('role').where('id', '=', uid).executeTakeFirst()
    if (!user) throw new DomainError('unauthenticated')
    if (user.role === 'banned') throw new DomainError('user_banned')
  }
  async function unread(uid: number, through?: number) {
    const limited = visible(db, uid)
      .$if(through !== undefined, (query) => query.where('notifications.id', '<=', through!))
      .where('notifications.read_at', 'is', null)
      .select('notifications.id')
      .limit(100)
      .as('unread')
    return countRows(db.selectFrom(limited))
  }
  const rows = (uid: number) =>
    visible(db, uid)
      .selectAll('notifications')
      .select(['notification_broadcasts.title', 'notification_broadcasts.body'])
  async function mutate<T>(uid: number, run: (tx: Kysely<CoreDatabase>) => Promise<T>): Promise<T> {
    return transactionWithRetry(db, async (tx) => {
      // 先锁操作者，再写他自己的通知；与用户中心的账号删除顺序一致。
      const user = await lockUser(tx, uid)
      if (user.role === 'banned') throw new DomainError('user_banned')
      return run(tx)
    })
  }
  return {
    async summary(uid: number, locale: Locale) {
      await requireUser(uid)
      const latest = await rows(uid)
        .where('notifications.read_at', 'is', null)
        .orderBy('notifications.id', 'desc')
        .limit(5)
        .execute()
      return { unread: await unread(uid), latest: latest.map((row) => renderNotification(row, locale, plugins)) }
    },
    async list(uid: number, locale: Locale, input: { filter: 'all' | 'unread'; page: number }) {
      await requireUser(uid)
      // 先定水位，条目和计数都只看水位以内的：读的中途新到的通知这一页不显示，“全部标为已读”也不会标掉它。
      const latest =
        (
          await visible(db, uid)
            .select('notifications.id')
            .orderBy('notifications.id', 'desc')
            .limit(1)
            .executeTakeFirst()
        )?.id ?? 0
      const shown = visible(db, uid).where('notifications.id', '<=', latest)
      const query = input.filter === 'unread' ? shown.where('notifications.read_at', 'is', null) : shown
      const found = await query
        .selectAll('notifications')
        .select(['notification_broadcasts.title', 'notification_broadcasts.body'])
        .orderBy('notifications.id', 'desc')
        .limit(20)
        .offset((Math.max(1, Math.trunc(input.page)) - 1) * 20)
        .execute()
      return {
        items: found.map((row) => renderNotification(row, locale, plugins)),
        total: await countRows(query),
        unread: await unread(uid, latest),
        latestId: latest || null,
      }
    },
    async markRead(uid: number, id: number): Promise<void> {
      await mutate(uid, async (tx) => {
        if (!(await visible(tx, uid).where('notifications.id', '=', id).select('notifications.id').executeTakeFirst()))
          throw new DomainError('notification_not_found')
        await tx
          .updateTable('notifications')
          .set({ read_at: toIsoTimestamp(now()) })
          .where('id', '=', id)
          .where('user_id', '=', uid)
          .where('read_at', 'is', null)
          .execute()
      })
    },
    async markAllRead(uid: number, through: number): Promise<number> {
      return mutate(uid, async (tx) => {
        const result = await tx
          .updateTable('notifications')
          .set({ read_at: toIsoTimestamp(now()) })
          .where('user_id', '=', uid)
          .where('id', '<=', through)
          .where('read_at', 'is', null)
          .where((eb) =>
            eb.or([
              eb('broadcast_id', 'is', null),
              eb.exists(
                eb
                  .selectFrom('notification_broadcasts')
                  .select('id')
                  .whereRef('notification_broadcasts.id', '=', 'notifications.broadcast_id')
                  .where('status', '!=', 'recalled'),
              ),
            ]),
          )
          .executeTakeFirstOrThrow()
        return Number(result.numUpdatedRows)
      })
    },
    async remove(uid: number, id: number): Promise<void> {
      await mutate(uid, async (tx) => {
        const result = await tx
          .deleteFrom('notifications')
          .where('user_id', '=', uid)
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
        if (result.numDeletedRows === 0n) throw new DomainError('notification_not_found')
      })
    },
  }
}
