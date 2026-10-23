import { lockForReference, type CoreDatabase, type IsoTimestamp } from '@nextskin/db'
import type { AdminAccountChange } from '@nextskin/email'
import { sql, type Transaction } from 'kysely'
import { rolesWithPermission } from '../access/permissions.ts'

export type AccountChange =
  Exclude<AdminAccountChange, { kind: 'binding' }> | { kind: 'binding'; pluginId: string; providerId: string }
export interface SystemNotificationParams {
  'update.available': { version: string }
  'report.resolved': {
    reportId: number
    tid: number
    textureName: string
    outcome: 'resolved' | 'rejected'
    refunded: number
    rewarded: number
  }
  'report.pending': Record<string, never>
  'texture.removed': { tid: number; name: string; action: 'unpublished' | 'deleted' }
  'account.changed': { changes: readonly AccountChange[] }
}

/** 用例已持有自己的行和业务对象的锁；从仍存在的 users 行插入，收件人同时注销时不写，也不报外键错误。 */
export async function notify<Type extends keyof SystemNotificationParams>(
  tx: Transaction<CoreDatabase>,
  uid: number,
  type: Type,
  params: SystemNotificationParams[Type],
  at: IsoTimestamp,
): Promise<void> {
  await tx
    .insertInto('notifications')
    .columns(['user_id', 'type', 'params', 'created_at'])
    .expression(
      lockForReference(
        tx,
        tx
          .selectFrom('users')
          .select([
            'id as user_id',
            sql<string>`${type}`.as('type'),
            sql<string>`${JSON.stringify(params)}`.as('params'),
            sql<IsoTimestamp>`${at}`.as('created_at'),
          ])
          .where('id', '=', uid),
        'users',
      ),
    )
    .execute()
}

export async function notifyPendingReport(
  tx: Transaction<CoreDatabase>,
  reporter: number,
  at: IsoTimestamp,
): Promise<void> {
  // DISTINCT 阻止 MySQL 合并派生表：INSERT 的 NOT EXISTS 不能直接从目标表读。
  const pending = tx
    .selectFrom('notifications')
    .select('user_id')
    .distinct()
    .where('type', '=', 'report.pending')
    .where('read_at', 'is', null)
    .as('pending')
  await tx
    .insertInto('notifications')
    .columns(['user_id', 'type', 'params', 'created_at'])
    .expression(
      lockForReference(
        tx,
        tx
          .selectFrom('users')
          .select([
            'users.id as user_id',
            sql<string>`${'report.pending'}`.as('type'),
            sql<string>`${'{}'}`.as('params'),
            sql<IsoTimestamp>`${at}`.as('created_at'),
          ])
          .where('users.role', 'in', rolesWithPermission('reports.review'))
          .where('users.id', '!=', reporter)
          .where((eb) =>
            eb.not(eb.exists(eb.selectFrom(pending).select('user_id').whereRef('pending.user_id', '=', 'users.id'))),
          ),
        'users',
      ),
    )
    .execute()
}

/** 一次插入所有超级管理员；版本去重由调用方在持有 updates.state 的锁时完成。 */
export async function notifyUpdateAvailable(
  tx: Transaction<CoreDatabase>,
  version: string,
  at: IsoTimestamp,
): Promise<void> {
  await tx
    .insertInto('notifications')
    .columns(['user_id', 'type', 'params', 'created_at'])
    .expression(
      lockForReference(
        tx,
        tx
          .selectFrom('users')
          .select([
            'id as user_id',
            sql<string>`${'update.available'}`.as('type'),
            sql<string>`${JSON.stringify({ version })}`.as('params'),
            sql<IsoTimestamp>`${at}`.as('created_at'),
          ])
          .where('role', '=', 'superadmin'),
        'users',
      ),
    )
    .execute()
}
