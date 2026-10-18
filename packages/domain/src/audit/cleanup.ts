import { toIsoTimestamp, transactionWithRetry, type CoreDatabase } from '@nextskin/db'
import type { Kysely } from 'kysely'
import type { JobHandler } from '../jobs/runner.ts'
import type { createSettingQueries } from '../settings/queries.ts'

export const AUDIT_CLEANUP_JOB = 'core:audit-log-cleanup'

export function createAuditCleanup(options: {
  db: Kysely<CoreDatabase>
  settings: Pick<ReturnType<typeof createSettingQueries>, 'read'>
  now: () => Date
}): JobHandler {
  const { db, settings, now } = options
  return {
    concurrency: 1,
    timeoutMs: 600_000,
    async run({ signal }) {
      const days = (await settings.read(['audit.retentionDays']))['audit.retentionDays']
      if (days === 0) return
      const cutoff = toIsoTimestamp(new Date(now().getTime() - days * 86_400_000))
      for (;;) {
        signal.throwIfAborted()
        const done = await transactionWithRetry(db, async (tx) => {
          const rows = await tx
            .selectFrom('audit_logs')
            .select(['id', 'created_at'])
            .orderBy('id')
            .limit(1000)
            .execute()
          const expired = rows.filter((row) => row.created_at < cutoff)
          if (expired.length)
            await tx
              .deleteFrom('audit_logs')
              .where(
                'id',
                'in',
                expired.map((row) => row.id),
              )
              .execute()
          return rows.length < 1000 || expired.length !== rows.length
        })
        if (done) return
      }
    },
  }
}
