import type { CoreDatabase, UserRole } from '@nextskin/db'
import type { Transaction } from 'kysely'
import { DomainError } from '../errors.ts'
import { assertEmailVerified } from './email-verification.ts'

export interface UserActor {
  uid: number
}

export async function lockUser(tx: Transaction<CoreDatabase>, uid: number) {
  await tx
    .updateTable('users')
    .set((eb) => ({ role: eb.ref('role') }))
    .where('id', '=', uid)
    .execute()
  const user = await tx.selectFrom('users').select(['role', 'email_verified']).where('id', '=', uid).executeTakeFirst()
  if (!user) throw new DomainError('unauthenticated')
  return user
}

export function assertPlayerManagementAllowed(
  user: { role: UserRole; email_verified: boolean | number },
  requireVerification: boolean,
): void {
  if (user.role === 'banned') throw new DomainError('user_banned')
  assertEmailVerified(user, requireVerification)
}
