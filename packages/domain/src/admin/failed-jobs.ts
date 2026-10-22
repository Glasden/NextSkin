/**
 * 后台的失败任务页（ADR-0051）：核心任务（名字以 `core:` 开头）的死信，超级管理员查看、重试、删除。
 * 插件任务的死信在插件详情页（plugins/admin.ts）
 */
import { toIsoTimestamp, transactionWithRetry, type CoreDatabase } from '@nextskin/db'
import type { Kysely } from 'kysely'
import { can } from '../access/permissions.ts'
import { audit } from '../audit/write.ts'
import { DomainError } from '../errors.ts'
import type { JobHandler } from '../jobs/runner.ts'
import { CORE_JOB_PREFIX, countDeadLetters, deleteDeadLetter, nameStartsWith, retryDeadLetter } from '../jobs/store.ts'
import { authorize } from './context.ts'
import { pagination } from './queries.ts'
import type { AdminActor, AdminFailedJob } from './types.ts'

function coreRows(db: Kysely<CoreDatabase>) {
  return db.selectFrom('failed_jobs').where(nameStartsWith(CORE_JOB_PREFIX))
}

/** 存的不是合法的 JSON 时 valid 为 false：页面显示为空，也不能重试 */
function parsePayload(text: string): { value: unknown; valid: boolean } {
  try {
    return { value: JSON.parse(text) as unknown, valid: true }
  } catch {
    return { value: null, valid: false }
  }
}

function payloadUid(payload: unknown): number | null {
  if (typeof payload !== 'object' || payload === null || !('uid' in payload)) return null
  return Number.isSafeInteger(payload.uid) && (payload.uid as number) > 0 ? (payload.uid as number) : null
}

export function createAdminFailedJobs(options: {
  db: Kysely<CoreDatabase>
  handlers: ReadonlyMap<string, JobHandler>
  now: () => Date
}) {
  const { db, handlers, now } = options

  /** 没有处理函数的任务放回队列后永远不会被认领；处理函数不认的载荷放回去只会再失败（ADR-0051） */
  function retryable(name: string, payload: { value: unknown; valid: boolean }): boolean {
    const handler = name.startsWith(CORE_JOB_PREFIX) ? handlers.get(name) : undefined
    if (!handler || !payload.valid) return false
    try {
      return handler.retryable?.(payload.value) ?? true
    } catch {
      return false
    }
  }

  async function requireManage(uid: number) {
    const user = await db.selectFrom('users').select('role').where('id', '=', uid).executeTakeFirst()
    if (!user || !can(user.role, 'jobs.manage')) throw new DomainError('permission_denied')
  }

  return {
    /** 最新的在前。latestId 是全部核心死信里最大的编号，页面的"全部重试""全部删除"带上它 */
    async listFailedJobs(
      viewer: number,
      input: { page: number; perPage?: number },
    ): Promise<{ total: number; latestId: number | null; items: AdminFailedJob[] }> {
      await requireManage(viewer)
      const { limit, offset } = pagination(input)
      const rows = await coreRows(db)
        .select(['id', 'name', 'payload', 'attempts', 'last_error', 'created_at', 'failed_at'])
        .orderBy('id', 'desc')
        .limit(limit)
        .offset(offset)
        .execute()
      const latest = await coreRows(db).select('id').orderBy('id', 'desc').limit(1).executeTakeFirst()
      const payloads = new Map(rows.map((row) => [row.id, parsePayload(row.payload)]))
      const uids = [
        ...new Set([...payloads.values()].map((payload) => payloadUid(payload.value)).filter((uid) => uid !== null)),
      ]
      const users = new Map(
        uids.length
          ? (await db.selectFrom('users').select(['id', 'nickname']).where('id', 'in', uids).execute()).map((user) => [
              user.id,
              user.nickname,
            ])
          : [],
      )
      return {
        total: await countDeadLetters(db, CORE_JOB_PREFIX),
        latestId: latest?.id ?? null,
        items: rows.map((row) => {
          const payload = payloads.get(row.id)!
          const uid = payloadUid(payload.value)
          const nickname = uid === null ? undefined : users.get(uid)
          return {
            id: row.id,
            name: row.name,
            payload: payload.value,
            attempts: row.attempts,
            lastError: row.last_error,
            createdAt: row.created_at,
            failedAt: row.failed_at,
            retryable: retryable(row.name, payload),
            user: uid !== null && nickname !== undefined ? { uid, nickname } : null,
          }
        }),
      }
    },

    async retryFailedJob(actor: AdminActor, id: number): Promise<void> {
      await transactionWithRetry(db, async (tx) => {
        const eventActor = await authorize(tx, actor, 'jobs.manage')
        const row = await tx
          .selectFrom('failed_jobs')
          .select(['name', 'payload'])
          .where('id', '=', id)
          .executeTakeFirst()
        if (!row || !row.name.startsWith(CORE_JOB_PREFIX)) throw new DomainError('dead_letter_not_found')
        if (!retryable(row.name, parsePayload(row.payload))) throw new DomainError('dead_letter_not_retryable')
        const at = toIsoTimestamp(now())
        if (!(await retryDeadLetter(tx, { id, prefix: CORE_JOB_PREFIX, now: at })))
          throw new DomainError('dead_letter_not_found')
        await audit(tx, {
          actor: eventActor,
          action: 'job.deadLetter',
          subject: { type: 'job', id },
          details: { action: 'retry', name: row.name },
          ip: actor.ip,
          now: at,
        })
      })
    },

    async deleteFailedJob(actor: AdminActor, id: number): Promise<void> {
      await transactionWithRetry(db, async (tx) => {
        const eventActor = await authorize(tx, actor, 'jobs.manage')
        const row = await tx.selectFrom('failed_jobs').select('name').where('id', '=', id).executeTakeFirst()
        if (!row || !(await deleteDeadLetter(tx, { id, prefix: CORE_JOB_PREFIX })))
          throw new DomainError('dead_letter_not_found')
        await audit(tx, {
          actor: eventActor,
          action: 'job.deadLetter',
          subject: { type: 'job', id },
          details: { action: 'delete', name: row.name },
          ip: actor.ip,
          now: toIsoTimestamp(now()),
        })
      })
    },

    /**
     * 重试编号不大于 through 的全部核心死信里能重试的，其余留着（ADR-0051）。through 是页面打开时看到的最大编号：
     * 之后才失败的任务管理员还没看过
     */
    async retryAllFailedJobs(actor: AdminActor, through: number): Promise<{ retried: number; skipped: number }> {
      return transactionWithRetry(db, async (tx) => {
        const eventActor = await authorize(tx, actor, 'jobs.manage')
        const rows = await coreRows(tx)
          .select(['id', 'name', 'payload'])
          .where('id', '<=', through)
          .orderBy('id')
          .execute()
        const at = toIsoTimestamp(now())
        let retried = 0
        let skipped = 0
        for (const row of rows) {
          if (!retryable(row.name, parsePayload(row.payload))) skipped++
          else if (await retryDeadLetter(tx, { id: row.id, prefix: CORE_JOB_PREFIX, now: at })) retried++
        }
        if (retried > 0)
          await audit(tx, {
            actor: eventActor,
            action: 'job.deadLetter',
            subject: { type: 'job', id: 0 },
            details: { action: 'retryAll', count: retried, skipped },
            ip: actor.ip,
            now: at,
          })
        return { retried, skipped }
      })
    },

    /** 删除编号不大于 through 的全部核心死信，理由同 retryAllFailedJobs */
    async deleteAllFailedJobs(actor: AdminActor, through: number): Promise<{ deleted: number }> {
      return transactionWithRetry(db, async (tx) => {
        const eventActor = await authorize(tx, actor, 'jobs.manage')
        const result = await tx
          .deleteFrom('failed_jobs')
          .where(nameStartsWith(CORE_JOB_PREFIX))
          .where('id', '<=', through)
          .executeTakeFirstOrThrow()
        const deleted = Number(result.numDeletedRows)
        if (deleted > 0)
          await audit(tx, {
            actor: eventActor,
            action: 'job.deadLetter',
            subject: { type: 'job', id: 0 },
            details: { action: 'deleteAll', count: deleted },
            ip: actor.ip,
            now: toIsoTimestamp(now()),
          })
        return { deleted }
      })
    },
  }
}
