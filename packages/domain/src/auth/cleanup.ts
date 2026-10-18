import { toIsoTimestamp, transactionWithRetry, writeAuthDate, type CoreDatabase } from '@nextskin/db'
import type { Kysely } from 'kysely'
import type { JobHandler } from '../jobs/runner.ts'

export const AUTH_CLEANUP_JOB = 'core:auth-cleanup'

export function createAuthCleanup(options: { db: Kysely<CoreDatabase>; now: () => Date }): JobHandler {
  const { db, now } = options
  return {
    concurrency: 1,
    timeoutMs: 600_000,
    async run({ signal }) {
      const cutoff = toIsoTimestamp(new Date(now().getTime() - 86_400_000))
      const authCutoff = writeAuthDate(db, cutoff)
      for (const table of [
        'oauth_access_tokens',
        'oauth_refresh_tokens',
        'sessions',
        'oauth_client_assertions',
        'device_codes',
        'yggdrasil_tokens',
      ] as const) {
        for (;;) {
          signal.throwIfAborted()
          const size = await transactionWithRetry(db, async (tx) => {
            let query = tx
              .selectFrom(table)
              .select('id')
              .where('expires_at', '<', table === 'yggdrasil_tokens' ? cutoff : authCutoff)
            if (table === 'oauth_refresh_tokens') {
              // refresh_id 是级联删除外键；仍被访问令牌引用的刷新令牌必须保留。
              query = query.where((eb) =>
                eb.not(
                  eb.exists(
                    eb
                      .selectFrom('oauth_access_tokens')
                      .select('id')
                      .whereRef('oauth_access_tokens.refresh_id', '=', 'oauth_refresh_tokens.id'),
                  ),
                ),
              )
            }
            const rows = await query.limit(1000).execute()
            if (rows.length) {
              let deletion = tx.deleteFrom(table).where(
                'id',
                'in',
                rows.map((row) => row.id),
              )
              if (table === 'oauth_refresh_tokens') {
                deletion = deletion.where((eb) =>
                  eb.not(
                    eb.exists(
                      eb
                        .selectFrom('oauth_access_tokens')
                        .select('id')
                        .whereRef('oauth_access_tokens.refresh_id', '=', 'oauth_refresh_tokens.id'),
                    ),
                  ),
                )
              }
              await deletion.execute()
            }
            return rows.length
          })
          if (size < 1000) break
        }
      }
      for (;;) {
        signal.throwIfAborted()
        const size = await transactionWithRetry(db, async (tx) => {
          const rows = await tx
            .selectFrom('device_code_selections')
            .select('device_code')
            .where('created_at', '<', cutoff)
            .where((eb) =>
              eb.not(
                eb.exists(
                  eb
                    .selectFrom('device_codes')
                    .select('id')
                    .whereRef('device_codes.device_code', '=', 'device_code_selections.device_code'),
                ),
              ),
            )
            .limit(1000)
            .execute()
          if (rows.length)
            await tx
              .deleteFrom('device_code_selections')
              .where(
                'device_code',
                'in',
                rows.map((row) => row.device_code),
              )
              .execute()
          return rows.length
        })
        if (size < 1000) break
      }
    },
  }
}
