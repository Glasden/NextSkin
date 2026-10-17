import { coreMigrations, migrateToLatest, toIsoTimestamp, transactionWithRetry, type CoreDatabase } from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import type { EventEnvelope } from '@nextskin/plugin-sdk'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createJobRunner, type JobHandler } from '../jobs/runner.ts'
import { createEvents } from './emit.ts'

let database: TestDatabase<CoreDatabase>
const now = toIsoTimestamp(new Date('2030-01-01T00:00:00.000Z'))
const data = { player: { pid: 1, uid: 2, name: 'Steve', uuid: 'a'.repeat(32), skin: null, cape: null, updatedAt: now } }

beforeAll(async () => {
  database = await createTestDatabase<CoreDatabase>()
  await migrateToLatest(database.db, coreMigrations)
})
afterAll(async () => database?.cleanup())
beforeEach(async () => {
  await database.db.deleteFrom('jobs').execute()
})

function setup() {
  const handlers = new Map<string, JobHandler>()
  const jobs = createJobRunner({ db: database.db, handlers, now: () => new Date(now) })
  return { jobs, events: createEvents(jobs, handlers) }
}

test('每个订阅者各得一个任务和一份信封；回滚时一起消失；没有订阅者不写', async () => {
  const { jobs, events } = setup()
  const received: Record<string, EventEnvelope<'player.created'>[]> = { a: [], b: [] }
  for (const key of ['a', 'b'] as const)
    events.subscribe('player.created', `test:${key}:on:player.created`, {
      run: ({ event }) => {
        received[key]!.push(event)
        return Promise.resolve()
      },
    })
  await transactionWithRetry(database.db, (tx) =>
    events.emit(tx, 'player.deleted', { kind: 'system' }, { pid: 1, uid: 2, name: 'Steve', uuid: 'a'.repeat(32) }, now),
  )
  expect(await database.db.selectFrom('jobs').selectAll().execute()).toEqual([])
  await expect(
    transactionWithRetry(database.db, async (tx) => {
      await events.emit(tx, 'player.created', { kind: 'system' }, data, now)
      throw new Error('rollback')
    }),
  ).rejects.toThrow('rollback')
  expect(await database.db.selectFrom('jobs').selectAll().execute()).toEqual([])

  await transactionWithRetry(database.db, (tx) =>
    events.emit(tx, 'player.created', { kind: 'user', uid: 2, role: 'user' }, data, now),
  )
  await jobs.drain()
  expect(received.a).toHaveLength(1)
  expect(received.a![0]).toMatchObject({
    name: 'player.created',
    occurredAt: now,
    actor: { kind: 'user', uid: 2, role: 'user' },
    data,
  })
  expect(received.a![0]!.id).toMatch(/^[0-9a-f-]{36}$/)
  expect(received.b).toEqual(received.a)
})

test('不在事务里发事件、重复登记同一个任务名都直接报错', async () => {
  const { events } = setup()
  const handler = { run: () => Promise.resolve() }
  events.subscribe('user.deleted', 'test:on:user.deleted', handler)
  await expect(events.emit(database.db, 'user.deleted', { kind: 'system' }, { uid: 1 }, now)).rejects.toThrow(TypeError)
  expect(() => events.subscribe('user.deleted', 'test:on:user.deleted', handler)).toThrow('test:on:user.deleted')
})
