import { readAuthBoolean, type CoreDatabase, type IsoTimestamp, type UserRole } from '@nextskin/db'
import type { Actor } from '@nextskin/plugin-sdk'
import type { Kysely, Transaction } from 'kysely'
import { can, outranks, type CorePermission } from '../access/permissions.ts'
import { audit } from '../audit/write.ts'
import { DomainError } from '../errors.ts'
import type { Events } from '../events/emit.ts'
import { lockUser } from '../users/lock.ts'
import type { AdminActor } from './types.ts'

/** 后台用例里事件和审计的 actor：锁住操作者的行之后，按数据库里的身份构造（ADR-0027） */
export interface AdminEventActor {
  kind: 'user'
  uid: number
  role: UserRole
}

/** 每个后台用例的第一步：锁住操作者自己的行，按数据库里的身份检查每一项权限（ADR-0027 的加锁顺序：先自己，再对象） */
export async function authorize(
  tx: Transaction<CoreDatabase>,
  actor: AdminActor,
  ...permissions: CorePermission[]
): Promise<AdminEventActor> {
  const user = await lockUser(tx, actor.uid)
  for (const permission of permissions) if (!can(user.role, permission)) throw new DomainError('permission_denied')
  return { kind: 'user', uid: actor.uid, role: user.role }
}

/**
 * 事务外、不加锁的预检，判断的顺序同 authorize 加 manageableTarget。算 scrypt、查快照这类昂贵的事之前先挡住
 * 没有权限、动不了对象的请求：后台的接口只要求登录，不然谁都能让服务器白算。结论不作数，事务里锁住之后重新判断
 */
export async function precheck(
  db: Kysely<CoreDatabase>,
  actor: AdminActor,
  uid: number,
  ...permissions: CorePermission[]
): Promise<void> {
  const rows = await db.selectFrom('users').select(['id', 'role']).where('id', 'in', [actor.uid, uid]).execute()
  const self = rows.find((row) => row.id === actor.uid)
  if (!self) throw new DomainError('unauthenticated')
  for (const permission of permissions) if (!can(self.role, permission)) throw new DomainError('permission_denied')
  const target = rows.find((row) => row.id === uid)
  if (!target) throw new DomainError('user_not_found')
  if (!outranks(self.role, target.role)) throw new DomainError('user_not_manageable')
}

export interface TargetUser {
  id: number
  nickname: string
  email: string
  emailVerified: boolean
  emailVersion: number
  role: UserRole
  score: number
  locale: string | null
  twoFactorEnabled: boolean
}

/** 锁住对象用户的行再读出来；用户不存在时返回 undefined（不抛 unauthenticated，那是 lockUser 对操作者的语义） */
export async function lockTarget(tx: Transaction<CoreDatabase>, uid: number): Promise<TargetUser | undefined> {
  await tx
    .updateTable('users')
    .set((eb) => ({ role: eb.ref('role') }))
    .where('id', '=', uid)
    .execute()
  const row = await tx
    .selectFrom('users')
    .select([
      'id',
      'nickname',
      'email',
      'email_verified',
      'email_version',
      'role',
      'score',
      'locale',
      'two_factor_enabled',
    ])
    .where('id', '=', uid)
    .executeTakeFirst()
  return row
    ? {
        id: row.id,
        nickname: row.nickname,
        email: row.email,
        emailVerified: readAuthBoolean(row.email_verified),
        emailVersion: row.email_version,
        role: row.role,
        score: row.score,
        locale: row.locale,
        twoFactorEnabled: readAuthBoolean(row.two_factor_enabled ?? false),
      }
    : undefined
}

/**
 * 锁住对象，确认操作者能管理他：对象的身份要严格低于自己（ADR-0036"能对谁做"）。所以后台动不了自己，
 * 普通管理员动不了其他管理员，谁都动不了超级管理员。对象被封禁、邮箱没验证都不影响
 */
export async function manageableTarget(
  tx: Transaction<CoreDatabase>,
  actor: AdminEventActor,
  uid: number,
): Promise<TargetUser> {
  const target = await lockTarget(tx, uid)
  if (!target) throw new DomainError('user_not_found')
  if (!outranks(actor.role, target.role)) throw new DomainError('user_not_manageable')
  return target
}

/** 改身份（`users.role`）：发 user.roleChanged、写审计。后台改用户、处理举报时封禁上传者、命令行共用 */
export async function changeRole(
  tx: Transaction<CoreDatabase>,
  events: Events,
  target: { id: number; nickname: string; role: UserRole },
  role: UserRole,
  actor: Actor,
  ip: string | null,
  timestamp: IsoTimestamp,
  reportId?: number,
) {
  if (target.role === role) return
  await tx.updateTable('users').set({ role }).where('id', '=', target.id).execute()
  await events.emit(tx, 'user.roleChanged', actor, { uid: target.id, from: target.role, to: role }, timestamp)
  await audit(tx, {
    actor,
    action: 'user.setRole',
    subject: { type: 'user', id: target.id },
    details: {
      from: target.role,
      to: role,
      nickname: target.nickname,
      ...(reportId === undefined ? {} : { reportId }),
    },
    ip,
    now: timestamp,
  })
}
