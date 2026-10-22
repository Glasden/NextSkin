import { createHash } from 'node:crypto'
import { isUniqueViolation, toIsoTimestamp, transactionWithRetry, type CoreDatabase } from '@nextskin/db'
import type { Kysely } from 'kysely'
import { DomainError } from '../errors.ts'
import { lockUser } from '../users/lock.ts'
import { PluginCallRejected } from '../plugins/errors.ts'

export interface PluginNotificationInput {
  pluginId: string
  uid: number
  title: string
  body?: string
  params?: Readonly<Record<string, string | number>>
  link?: string
  key: string
  now: Date
}

/** 输入由 RPC 校验；键与通知原子提交，不检查封禁、不写审计、不发事件（ADR-0041、0052）。 */
export async function sendPluginNotification(
  db: Kysely<CoreDatabase>,
  input: PluginNotificationInput,
): Promise<{ status: 'sent' | 'duplicate' | 'userNotFound' }> {
  const { pluginId, uid, title, body, link, key, now } = input
  // 排序和散列在事务外完成，不占用 SQLite 的全局写锁。
  const params =
    input.params === undefined
      ? null
      : Object.fromEntries(Object.entries(input.params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ uid, title, body: body ?? null, params, link: link ?? null }))
    .digest('hex')
  const createdAt = toIsoTimestamp(now)
  async function duplicate(executor: Kysely<CoreDatabase>) {
    const entry = await executor
      .selectFrom('plugin_notification_keys')
      .select('fingerprint')
      .where('plugin_id', '=', pluginId)
      .where('plugin_key', '=', key)
      .executeTakeFirst()
    if (!entry) return undefined
    if (entry.fingerprint !== fingerprint) throw new PluginCallRejected('同一个 key 已经用于另一条通知')
    return { status: 'duplicate' as const }
  }
  try {
    return await transactionWithRetry(db, async (tx) => {
      const replay = await duplicate(tx)
      if (replay) return replay
      // 同改积分：先认永久键，用户不存在不占键，之后可以用原 key 重试；大 uid 避免 PG integer 溢出。
      if (uid > 2147483647) return { status: 'userNotFound' as const }
      // 锁住收件人直到提交，避免预查后用户被并发删除而撞外键；不检查身份。
      await lockUser(tx, uid)
      await tx
        .insertInto('plugin_notification_keys')
        .values({ plugin_id: pluginId, plugin_key: key, user_id: uid, fingerprint, created_at: createdAt })
        .execute()
      await tx
        .insertInto('notifications')
        .values({
          user_id: uid,
          type: 'plugin',
          plugin_id: pluginId,
          title_key: title,
          body_key: body ?? null,
          params: params === null ? null : JSON.stringify(params),
          link: link ?? null,
          broadcast_id: null,
          read_at: null,
          created_at: createdAt,
        })
        .execute()
      return { status: 'sent' as const }
    })
  } catch (error) {
    if (error instanceof DomainError && error.code === 'unauthenticated') return { status: 'userNotFound' }
    // 主键冲突到这里时整个事务已经回滚；在事务外读取并发已提交的键。
    if (isUniqueViolation(db, error)) {
      const replay = await duplicate(db)
      if (replay) return replay
    }
    throw error
  }
}
