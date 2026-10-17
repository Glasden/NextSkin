import { randomInt } from 'node:crypto'
import { toIsoTimestamp, transactionWithRetry, type CoreDatabase, type IsoTimestamp } from '@nextskin/db'
import type { Kysely } from 'kysely'
import { DomainError } from '../errors.ts'
import { adjustScore } from '../score/adjust.ts'
import type { createSettingQueries } from '../settings/queries.ts'
import type { UserActor } from './lock.ts'

export interface CheckInRules {
  gapHours: number
  resetAtMidnight: boolean
  timeZone: string
}
export interface CheckInResult {
  delta: number
  score: number
  nextAt: IsoTimestamp | null
}

function dayStart(now: Date, timeZone: string, days = 0): IsoTimestamp {
  const format = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' })
  const localDay = (date: Date) => {
    const parts = format.formatToParts(date)
    const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)!.value)
    return Date.UTC(value('year'), value('month') - 1, value('day'))
  }
  const target = localDay(now) + days * 86400000
  // 按当地日期找第一毫秒，避免把夏令时切换日误当成固定 24 小时。
  let lo = target - 48 * 3600000
  let hi = target + 48 * 3600000
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (localDay(new Date(mid)) < target) lo = mid + 1
    else hi = mid
  }
  return toIsoTimestamp(new Date(lo))
}

export function nextCheckInAt(last: IsoTimestamp | null, now: Date, rules: CheckInRules): IsoTimestamp | null {
  if (last === null) return null
  if (rules.resetAtMidnight) {
    // 恰好在零点签的那一次算今天的，今天不能再签
    if (last < dayStart(now, rules.timeZone)) return null
    return dayStart(new Date(last), rules.timeZone, 1)
  }
  const next = toIsoTimestamp(new Date(new Date(last).getTime() + rules.gapHours * 3600000))
  return next <= toIsoTimestamp(now) ? null : next
}

export function createCheckIn(db: Kysely<CoreDatabase>, settings: ReturnType<typeof createSettingQueries>) {
  return async function checkIn(actor: UserActor): Promise<CheckInResult> {
    const values = await settings.read([
      'checkIn.score',
      'checkIn.gapHours',
      'checkIn.resetAtMidnight',
      'site.timeZone',
    ])
    const rules = {
      gapHours: values['checkIn.gapHours'],
      resetAtMidnight: values['checkIn.resetAtMidnight'],
      timeZone: values['site.timeZone'],
    }
    return transactionWithRetry(db, async (tx) => {
      const now = new Date()
      const timestamp = toIsoTimestamp(now)
      const cutoff = rules.resetAtMidnight
        ? dayStart(now, rules.timeZone)
        : toIsoTimestamp(new Date(now.getTime() - rules.gapHours * 3600000))
      const result = await tx
        .updateTable('users')
        .set({ last_check_in_at: timestamp })
        .where('id', '=', actor.uid)
        .where('role', '!=', 'banned')
        .where((eb) =>
          eb.or([
            eb('last_check_in_at', 'is', null),
            eb('last_check_in_at', rules.resetAtMidnight ? '<' : '<=', cutoff),
          ]),
        )
        .executeTakeFirstOrThrow()
      const user = await tx
        .selectFrom('users')
        .select(['role', 'score', 'last_check_in_at'])
        .where('id', '=', actor.uid)
        .executeTakeFirst()
      if (!user) throw new DomainError('unauthenticated')
      if (user.role === 'banned') throw new DomainError('user_banned')
      if (result.numUpdatedRows === 0n)
        throw new DomainError('check_in_too_early', { nextAt: nextCheckInAt(user.last_check_in_at, now, rules)! })
      const { min, max } = values['checkIn.score']
      const delta = randomInt(min, max + 1)
      const score =
        delta > 0
          ? (await adjustScore(tx, { uid: actor.uid, delta, reason: 'score.reasons.checkIn', now: timestamp })).score
          : user.score
      return { delta, score, nextAt: nextCheckInAt(timestamp, now, rules) }
    })
  }
}
