import { countRows, readAuthBoolean, type CoreDatabase, type IsoTimestamp, type UserRole } from '@nextskin/db'
import type { Kysely } from 'kysely'
import type { createSettingQueries } from '../settings/queries.ts'
import { nextCheckInAt } from './check-in.ts'

export interface UserOverview {
  uid: number
  nickname: string
  email: string
  emailVerified: boolean
  role: UserRole
  score: number
  playerCount: number
  lastCheckInAt: IsoTimestamp | null
  /** null 表示现在就能签到。 */
  nextCheckInAt: IsoTimestamp | null
}

export function createUserQueries(db: Kysely<CoreDatabase>, settings: ReturnType<typeof createSettingQueries>) {
  return {
    async overview(uid: number): Promise<UserOverview | null> {
      const row = await db
        .selectFrom('users')
        .select(['id', 'nickname', 'email', 'email_verified', 'role', 'score', 'last_check_in_at'])
        .where('id', '=', uid)
        .executeTakeFirst()
      if (!row) return null
      const values = await settings.read(['checkIn.gapHours', 'checkIn.resetAtMidnight', 'site.timeZone'])
      return {
        uid: row.id,
        nickname: row.nickname,
        email: row.email,
        emailVerified: readAuthBoolean(row.email_verified),
        role: row.role,
        score: row.score,
        playerCount: await countRows(db.selectFrom('players').where('user_id', '=', uid)),
        lastCheckInAt: row.last_check_in_at,
        nextCheckInAt: nextCheckInAt(row.last_check_in_at, new Date(), {
          gapHours: values['checkIn.gapHours'],
          resetAtMidnight: values['checkIn.resetAtMidnight'],
          timeZone: values['site.timeZone'],
        }),
      }
    },
  }
}
