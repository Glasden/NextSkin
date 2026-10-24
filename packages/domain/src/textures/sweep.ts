import { transactionWithRetry, type CoreDatabase } from '@nextskin/db'
import { rootLogger, type Logger } from '@nextskin/logging'
import type { Kysely } from 'kysely'
import { z } from 'zod'
import type { JobHandler, JobRunner } from '../jobs/runner.ts'
import type { TextureFiles } from './files.ts'
import type { TextureStorage } from './storage.ts'

export const TEXTURE_SWEEP_JOB = 'core:texture-sweep'
const payloadSchema = z.object({
  after: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable()
    .optional()
    .default(null),
  orphans: z.int().nonnegative().optional().default(0),
  temps: z.int().nonnegative().optional().default(0),
})

export function createTextureSweep(options: {
  db: Kysely<CoreDatabase>
  storage: TextureStorage
  files: Pick<TextureFiles, 'adoptOrphans'>
  jobs: Pick<JobRunner, 'enqueue'>
  now: () => Date
  leaseMs: number
  logger?: Logger
}): JobHandler {
  const { db, storage, files, jobs, now, leaseMs } = options
  const log = (options.logger ?? rootLogger()).child({ area: 'jobs' })
  return {
    concurrency: 1,
    async run({ jobId, payload, signal }) {
      const parsed = payloadSchema.parse(payload)
      const { after } = parsed
      let { orphans, temps } = parsed
      const timestamp = now().getTime()
      signal.throwIfAborted()
      if (after === null) {
        for (const temp of await storage.listTemp()) {
          signal.throwIfAborted()
          if (temp.modifiedAt.getTime() >= timestamp - leaseMs) continue
          const pending = await db
            .selectFrom('texture_files')
            .select('hash')
            .where('hash', '=', temp.hash)
            .where('status', '=', 'pending')
            .where('claim_id', '=', temp.claimId)
            .executeTakeFirst()
          if (!pending) {
            await storage.deleteTemp(temp.hash, temp.claimId)
            temps++
          }
        }
      }
      signal.throwIfAborted()
      const page = await storage.list({ after, limit: 1000 })
      const candidates = page
        .filter((entry) => entry.modifiedAt.getTime() < timestamp - 86_400_000)
        .map((entry) => entry.key)
      const existing = new Set(
        candidates.length
          ? (await db.selectFrom('texture_files').select('hash').where('hash', 'in', candidates).execute()).map(
              (row) => row.hash,
            )
          : [],
      )
      signal.throwIfAborted()
      orphans += await files.adoptOrphans(candidates.filter((hash) => !existing.has(hash)))
      signal.throwIfAborted()
      if (page.length === 1000) {
        await transactionWithRetry(db, async (tx) => {
          await tx.updateTable('jobs').set({ dedupe_key: null }).where('id', '=', jobId).execute()
          await jobs.enqueue(
            tx,
            TEXTURE_SWEEP_JOB,
            { after: page.at(-1)!.key, orphans, temps },
            { dedupeKey: TEXTURE_SWEEP_JOB },
          )
        })
      } else log.info('texture_sweep', { orphans, temps })
    },
  }
}
