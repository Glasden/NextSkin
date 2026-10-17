import { randomUUID } from 'node:crypto'
import type { CoreDatabase, IsoTimestamp } from '@nextskin/db'
import type { Actor, CoreEvents, EventEnvelope, EventName } from '@nextskin/plugin-sdk'
import type { Kysely } from 'kysely'
import type { JobHandler, JobRunner } from '../jobs/runner.ts'

/**
 * 事件在业务事务里按订阅者展开成任务，`jobs` 表就是 outbox（ADR-0021）。
 * 订阅者取发出事件那一刻的集合，之后才订阅的收不到之前的事件。
 */
export function createEvents(jobs: JobRunner, handlers: Map<string, JobHandler>) {
  const subscribers = new Map<EventName, Set<string>>()

  /**
   * 订阅事件：处理函数注册成一种任务，任务名由订阅者给出（插件是 `plugin:<id>:on:<事件名>`）。
   * 处理函数收到的载荷是完整的事件信封，按 SDK 的要求用 `event.id` 去重。
   */
  function subscribe<E extends EventName>(
    name: E,
    jobName: string,
    handler: Omit<JobHandler, 'run'> & {
      run(args: { event: EventEnvelope<E>; attempt: number; signal: AbortSignal }): Promise<void>
    },
  ): void {
    if (handlers.has(jobName)) throw new Error(`任务处理函数 ${jobName} 已经注册过了`)
    handlers.set(jobName, {
      ...handler,
      run: ({ payload, attempt, signal }) => handler.run({ event: payload as EventEnvelope<E>, attempt, signal }),
    })
    let set = subscribers.get(name)
    if (!set) subscribers.set(name, (set = new Set()))
    set.add(jobName)
  }

  /** 必须在业务事务里调用：事件随业务写入一起提交，回滚时也一起消失 */
  async function emit<E extends EventName>(
    tx: Kysely<CoreDatabase>,
    name: E,
    actor: Actor,
    data: CoreEvents[E],
    now: IsoTimestamp,
  ): Promise<void> {
    if (!tx.isTransaction) throw new TypeError('事件必须在业务事务里发出')
    const targets = subscribers.get(name)
    if (!targets?.size) return
    const event: EventEnvelope<E> = { id: randomUUID(), name, occurredAt: now, actor, data }
    for (const jobName of targets) await jobs.enqueue(tx, jobName, event)
  }

  return { subscribe, emit }
}

export type Events = ReturnType<typeof createEvents>
