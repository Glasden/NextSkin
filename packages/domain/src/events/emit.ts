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
  /** 插件订阅者：`user.registered` 的 `extra` 只给它自己贡献的表单字段（SDK 的 ExtraFields） */
  const pluginOf = new Map<string, string>()

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
    options: { pluginId?: string } = {},
  ): void {
    if (handlers.has(jobName)) throw new Error(`任务处理函数 ${jobName} 已经注册过了`)
    handlers.set(jobName, {
      ...handler,
      run: ({ payload, attempt, signal }) => handler.run({ event: payload as EventEnvelope<E>, attempt, signal }),
    })
    let set = subscribers.get(name)
    if (!set) subscribers.set(name, (set = new Set()))
    set.add(jobName)
    if (options.pluginId) pluginOf.set(jobName, options.pluginId)
  }

  /**
   * 取消订阅（插件停用时）：之后发出的事件不再展开给它；表里已有的任务留着，
   * 执行器只认领注册了处理函数的任务，重新启用后继续执行（ADR-0021）
   */
  function unsubscribe(name: EventName, jobName: string): void {
    subscribers.get(name)?.delete(jobName)
    handlers.delete(jobName)
    pluginOf.delete(jobName)
  }

  /** 必须在业务事务里调用：事件随业务写入一起提交，回滚时也一起消失 */
  /**
   * `options.extra`：按插件 id 分好的表单字段。插件订阅者收到的 `extra` 换成它自己那一份，
   * 核心的订阅者收到的是 `data` 原样
   */
  async function emit<E extends EventName>(
    tx: Kysely<CoreDatabase>,
    name: E,
    actor: Actor,
    data: CoreEvents[E],
    now: IsoTimestamp,
    options: { extra?: ReadonlyMap<string, Readonly<Record<string, string>>> } = {},
  ): Promise<void> {
    if (!tx.isTransaction) throw new TypeError('事件必须在业务事务里发出')
    const targets = subscribers.get(name)
    if (!targets?.size) return
    const id = randomUUID()
    for (const jobName of targets) {
      const pluginId = pluginOf.get(jobName)
      const own =
        pluginId !== undefined && 'extra' in data ? { ...data, extra: options.extra?.get(pluginId) ?? {} } : data
      const event: EventEnvelope<E> = { id, name, occurredAt: now, actor, data: own }
      await jobs.enqueue(tx, jobName, event)
    }
  }

  const hasSubscribers = (name: EventName): boolean => !!subscribers.get(name)?.size
  return { subscribe, unsubscribe, emit, hasSubscribers }
}

export type Events = ReturnType<typeof createEvents>
