/**
 * 删除也需要独立的尝试租期：只换 claim_id 不能阻止旧执行者稍后调用 delete。
 * 两个回收任务交错时，后者可能已删行并允许重新上传，旧执行者再恢复就会删掉新对象。
 * 租期内不接手；发请求前从持久化的 delete_attempted_at 计时，超过半个安全窗口就放弃。
 * 默认租期 10 分钟，远大于任务执行器默认的 60 秒超时；远程删除还受驱动的 L 约束。
 */
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  insertOrIgnore,
  toIsoTimestamp,
  transactionWithRetry,
  type CoreDatabase,
  type IsoTimestamp,
} from '@nextskin/db'
import type { Kysely } from 'kysely'
import { z } from 'zod'
import { DomainError } from '../errors.ts'
import type { JobHandler, JobRunner } from '../jobs/runner.ts'
import type { TextureStorage } from './storage.ts'

export const TEXTURE_LEASE_JOB = 'core:texture-lease'
export const TEXTURE_RECYCLE_JOB = 'core:texture-recycle'
export const TEXTURE_REMOVE_ROW_JOB = 'core:texture-remove-row'
const ATTEMPT_LEASE_MS = 10 * 60 * 1000
const payloadSchema = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/) })
const leaseSchema = payloadSchema.extend({ claimId: z.uuid() })

export function createTextureFiles(options: {
  db: Kysely<CoreDatabase>
  storage: TextureStorage
  renders: { purge(hash: string): Promise<void> }
  jobs: Pick<JobRunner, 'enqueue'>
  now: () => Date
  leaseMs: number
  deleteDelayMs: number
  attemptLeaseMs?: number
}) {
  const { db, storage, jobs, now, leaseMs, deleteDelayMs, attemptLeaseMs = ATTEMPT_LEASE_MS } = options
  const at = (offset = 0) => toIsoTimestamp(new Date(now().getTime() + offset))
  async function scheduleRecycle(tx: Kysely<CoreDatabase>, hash: string) {
    // 每次进入 deleting 都要排本轮 D 的任务；旧任务保留，但不占用新任务的 hash 去重键。
    await tx
      .updateTable('jobs')
      .set({ dedupe_key: null })
      .where('name', '=', TEXTURE_RECYCLE_JOB)
      .where('dedupe_key', '=', hash)
      .execute()
    await jobs.enqueue(tx, TEXTURE_RECYCLE_JOB, { hash }, { delayMs: deleteDelayMs + 1, dedupeKey: hash })
  }
  async function claim(pixelHash: string, waitBudget: { remainingMs: number }) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const found = await db
        .selectFrom('texture_files')
        .selectAll()
        .where('pixel_hash', '=', pixelHash)
        .where('status', '=', 'active')
        .orderBy('hash')
        .executeTakeFirst()
      if (found) return { file: found, claimId: null }
      const result = await transactionWithRetry(db, async (tx) => {
        const claimId = randomUUID(),
          timestamp = at()
        const inserted = await insertOrIgnore(
          tx,
          'texture_files',
          {
            hash: pixelHash,
            pixel_hash: null,
            width: null,
            height: null,
            size_bytes: null,
            ref_count: 0,
            status: 'pending',
            claim_id: claimId,
            status_changed_at: timestamp,
            created_at: timestamp,
            delete_attempted_at: null,
            delete_confirmed_at: null,
          },
          ['hash'],
        )
        const changed = inserted
          ? true
          : (
              await tx
                .updateTable('texture_files')
                .set({
                  status: 'pending',
                  claim_id: claimId,
                  status_changed_at: timestamp,
                })
                .where('hash', '=', pixelHash)
                .where('status', '=', 'deleting')
                .where('delete_attempted_at', 'is', null)
                .executeTakeFirstOrThrow()
            ).numUpdatedRows > 0n
        if (!changed) return null
        await jobs.enqueue(tx, TEXTURE_LEASE_JOB, { hash: pixelHash, claimId }, { delayMs: leaseMs })
        return {
          file: await tx
            .selectFrom('texture_files')
            .selectAll()
            .where('hash', '=', pixelHash)
            .executeTakeFirstOrThrow(),
          claimId,
        }
      })
      if (result) return result
      if (attempt < 9 && waitBudget.remainingMs >= 180) {
        waitBudget.remainingMs -= 180
        await sleep(180)
      } else break
    }
    throw new DomainError('service_unavailable')
  }
  async function release(tx: Kysely<CoreDatabase>, hash: string, timestamp: IsoTimestamp): Promise<boolean> {
    const decreased = await tx
      .updateTable('texture_files')
      .set((eb) => ({ ref_count: eb('ref_count', '-', 1) }))
      .where('hash', '=', hash)
      .where('status', '=', 'active')
      .where('ref_count', '>', 0)
      .executeTakeFirstOrThrow()
    if (decreased.numUpdatedRows !== 1n) throw new Error('材质文件引用数不一致')
    const marked = await tx
      .updateTable('texture_files')
      .set({
        status: 'deleting',
        status_changed_at: timestamp,
        claim_id: randomUUID(),
        delete_attempted_at: null,
        delete_confirmed_at: null,
      })
      .where('hash', '=', hash)
      .where('status', '=', 'active')
      .where('ref_count', '=', 0)
      .executeTakeFirstOrThrow()
    if (marked.numUpdatedRows === 1n) await scheduleRecycle(tx, hash)
    return marked.numUpdatedRows === 1n
  }
  async function removeRow(hash: string) {
    await db
      .deleteFrom('texture_files')
      .where('hash', '=', hash)
      .where('status', '=', 'deleting')
      .where('delete_confirmed_at', 'is not', null)
      .where('delete_attempted_at', storage.lateDeleteWindowMs === 0 ? '<=' : '<', at(-storage.lateDeleteWindowMs))
      .execute()
  }
  const handlers: Record<string, JobHandler> = {
    [TEXTURE_LEASE_JOB]: {
      async run({ payload }) {
        const { hash, claimId } = leaseSchema.parse(payload)
        await transactionWithRetry(db, async (tx) => {
          const changed = await tx
            .updateTable('texture_files')
            .set({
              status: 'deleting',
              status_changed_at: at(),
              claim_id: randomUUID(),
              delete_attempted_at: null,
              delete_confirmed_at: null,
            })
            .where('hash', '=', hash)
            .where('status', '=', 'pending')
            .where('claim_id', '=', claimId)
            .executeTakeFirstOrThrow()
          if (changed.numUpdatedRows === 1n) await scheduleRecycle(tx, hash)
        })
        await storage.deleteTemp(hash, claimId)
      },
    },
    [TEXTURE_RECYCLE_JOB]: {
      async run({ payload }) {
        const { hash } = payloadSchema.parse(payload)
        const claimId = randomUUID()
        const attemptedAt = await transactionWithRetry(db, async (tx) => {
          const timestamp = at()
          const deletingBefore = toIsoTimestamp(new Date(Date.parse(timestamp) - deleteDelayMs))
          const attemptBefore = toIsoTimestamp(new Date(Date.parse(timestamp) - attemptLeaseMs))
          const changed = await tx
            .updateTable('texture_files')
            .set({ claim_id: claimId, delete_attempted_at: timestamp, delete_confirmed_at: null })
            .where('hash', '=', hash)
            .where('status', '=', 'deleting')
            .where('status_changed_at', '<', deletingBefore)
            .where((eb) =>
              eb.or([eb('delete_attempted_at', 'is', null), eb('delete_attempted_at', '<', attemptBefore)]),
            )
            .executeTakeFirstOrThrow()
          // 运行中的任务释放去重键，让下一次进入 deleting 可以排新任务。
          if (changed.numUpdatedRows === 1n) {
            await tx
              .updateTable('jobs')
              .set({ dedupe_key: null })
              .where('name', '=', TEXTURE_RECYCLE_JOB)
              .where('dedupe_key', '=', hash)
              .execute()
            return timestamp
          }
          const file = await tx
            .selectFrom('texture_files')
            .select(['status', 'status_changed_at', 'delete_attempted_at', 'delete_confirmed_at'])
            .where('hash', '=', hash)
            .executeTakeFirst()
          if (
            file?.status === 'deleting' &&
            file.status_changed_at < deletingBefore &&
            file.delete_attempted_at !== null &&
            file.delete_confirmed_at === null &&
            file.delete_attempted_at >= attemptBefore
          ) {
            // 不带去重键：原执行者可能中途放弃，必须在它的租期之后保证还有一个任务。
            const delayMs = Math.max(1, Date.parse(file.delete_attempted_at) + attemptLeaseMs + 1 - now().getTime())
            await jobs.enqueue(tx, TEXTURE_RECYCLE_JOB, { hash }, { delayMs })
          }
          return null
        })
        if (attemptedAt === null) return
        const safetyWindowMs =
          storage.lateDeleteWindowMs > 0 ? Math.min(attemptLeaseMs, storage.lateDeleteWindowMs) : attemptLeaseMs
        if (now().getTime() - Date.parse(attemptedAt) >= safetyWindowMs / 2)
          throw new DomainError('service_unavailable')
        await storage.delete(hash)
        const confirmed = await transactionWithRetry(db, async (tx) => {
          const confirmed = await tx
            .updateTable('texture_files')
            .set({ delete_confirmed_at: at() })
            .where('hash', '=', hash)
            .where('status', '=', 'deleting')
            .where('claim_id', '=', claimId)
            .executeTakeFirstOrThrow()
          if (confirmed.numUpdatedRows !== 1n) return false
          if (storage.lateDeleteWindowMs > 0)
            await jobs.enqueue(tx, TEXTURE_REMOVE_ROW_JOB, { hash }, { delayMs: storage.lateDeleteWindowMs + 1 })
          return true
        })
        if (!confirmed) return
        await options.renders.purge(hash)
        if (storage.lateDeleteWindowMs === 0) await removeRow(hash)
      },
    },
    [TEXTURE_REMOVE_ROW_JOB]: {
      async run({ payload }) {
        await removeRow(payloadSchema.parse(payload).hash)
      },
    },
  }
  return { claim, release, handlers }
}
export type TextureFiles = ReturnType<typeof createTextureFiles>
