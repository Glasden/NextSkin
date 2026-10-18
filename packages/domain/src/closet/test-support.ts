import {
  coreMigrations,
  countRows,
  insertReturningId,
  migrateToLatest,
  toIsoTimestamp,
  transactionWithRetry,
  upsert,
  writeAuthDate,
  type CoreDatabase,
  type TextureType,
} from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import type { EventName } from '@nextskin/plugin-sdk'
import type { Transaction } from 'kysely'
import { afterAll, beforeAll, beforeEach, expect, vi } from 'vitest'
import { createCore, encodeSettingValue, type Core, type CoreSettingKey, type CoreSettingValue } from '../index.ts'
import { adjustScore } from '../score/adjust.ts'

const secretKey = 'test-only-secret-key-with-at-least-32-characters'
export const old = toIsoTimestamp(new Date('2020-01-01T00:00:00Z'))
export function setup() {
  let database: TestDatabase<CoreDatabase>,
    core: Core,
    owner: { uid: number },
    actor: { uid: number },
    clock: number,
    seed = 0
  let playerWrites = 0
  const db = () => database.db
  const now = () => toIsoTimestamp(new Date(clock))
  beforeAll(async () => {
    database = await createTestDatabase<CoreDatabase>()
    await migrateToLatest(db(), coreMigrations)
    database.db = db().withPlugin({
      transformQuery: ({ node }) => {
        if (node.kind === 'UpdateQueryNode' && JSON.stringify(node.table).includes('"players"')) playerWrites++
        return node
      },
      transformResult: ({ result }) => Promise.resolve(result),
    })
  })
  afterAll(async () => database?.cleanup())
  beforeEach(async () => {
    await db().deleteFrom('reports').execute()
    await db().deleteFrom('players').execute()
    await db().deleteFrom('closet_items').execute()
    await db().deleteFrom('textures').execute()
    await db().deleteFrom('texture_files').execute()
    await db().deleteFrom('users').execute()
    await db().deleteFrom('jobs').execute()
    await db().deleteFrom('settings').execute()
    clock = Date.parse('2026-10-18T00:00:00Z')
    core = createCore({
      db: db(),
      secretKey,
      production: false,
      now: () => new Date(clock),
      textureStorage: {
        list: () => Promise.resolve([]),
        listTemp: () => Promise.resolve([]),
        lateDeleteWindowMs: 0,
        read: () => Promise.resolve(null),
        write: () => Promise.resolve(),
        delete: () => Promise.resolve(),
        deleteTemp: () => Promise.resolve(),
      },
      imagePool: { close: () => Promise.resolve(), processUpload: vi.fn(), inspect: vi.fn(), render: vi.fn() },
    })
    await setting('score.perPlayer', 0)
    owner = await user('owner')
    actor = await user('actor')
  })
  async function user(name: string) {
    const uid = await insertReturningId(db(), 'users', {
      nickname: name,
      email: `${name}@example.test`,
      email_verified: true,
      created_at: writeAuthDate(db(), old),
      updated_at: writeAuthDate(db(), old),
    })
    await transactionWithRetry(db(), (tx) =>
      adjustScore(tx, { uid, delta: 1000, reason: 'score.reasons.initial', now: old }),
    )
    return { uid }
  }
  async function texture(type: TextureType = 'steve', visible = true, name = 'Texture') {
    const hash = (++seed).toString(16).padStart(64, '0')
    await db()
      .insertInto('texture_files')
      .values({
        hash,
        pixel_hash: hash,
        width: 64,
        height: type === 'cape' ? 32 : 64,
        size_bytes: 100,
        ref_count: 1,
        status: 'active',
        status_changed_at: old,
        created_at: old,
      })
      .execute()
    return insertReturningId(db(), 'textures', {
      hash,
      type,
      name,
      uploader_id: owner.uid,
      is_public: visible ? 1 : 0,
      created_at: old,
      updated_at: old,
    })
  }
  async function setting<K extends CoreSettingKey>(key: K, value: CoreSettingValue<K>) {
    await upsert(db(), 'settings', {
      values: { namespace: 'core', key, value: encodeSettingValue(key, value, { secretKey }), updated_at: old },
      conflict: ['namespace', 'key'],
      update: ['value', 'updated_at'],
    })
  }
  async function balance(uid = actor.uid) {
    return (await db().selectFrom('users').select('score').where('id', '=', uid).executeTakeFirstOrThrow()).score
  }
  function subscribe(...names: EventName[]) {
    for (const name of names) core.events.subscribe(name, `test:${name}`, { run: () => Promise.resolve() })
  }
  async function events(name: EventName) {
    return (
      await db().selectFrom('jobs').select('payload').where('name', '=', `test:${name}`).orderBy('id').execute()
    ).map(
      (row) =>
        JSON.parse(row.payload) as {
          actor: { kind: string; uid: number; role: string }
          data: Record<string, unknown>
        },
    )
  }
  async function ledger(uid = actor.uid) {
    return db()
      .selectFrom('score_transactions')
      .select(['delta', 'reason', 'subject_type', 'subject_id', 'created_at'])
      .where('user_id', '=', uid)
      .where('reason', '!=', 'score.reasons.initial')
      .orderBy('id')
      .execute()
  }
  async function consistent(tid: number) {
    const row = await db().selectFrom('textures').select('likes').where('id', '=', tid).executeTakeFirstOrThrow()
    expect(row.likes).toBe(await countRows(db().selectFrom('closet_items').where('texture_id', '=', tid)))
    for (const user of await db().selectFrom('users').select(['id', 'score']).execute()) {
      const entries = await db()
        .selectFrom('score_transactions')
        .select('delta')
        .where('user_id', '=', user.id)
        .execute()
      expect(entries.reduce((sum, entry) => sum + entry.delta, 0)).toBe(user.score)
    }
  }
  /** 暂停业务回调结束后的提交；后来的请求必须等待用户或材质行锁。 */
  function pauseNextCommit() {
    const entered = Promise.withResolvers<void>(),
      contended = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    const transaction = db().transaction.bind(db())
    let armed = true
    const spy = vi.spyOn(db(), 'transaction').mockImplementation(() => {
      const builder = transaction(),
        execute = builder.execute.bind(builder)
      builder.execute = <T>(run: (tx: Transaction<CoreDatabase>) => Promise<T>) => {
        if (!armed) contended.resolve()
        return execute(async (tx) => {
          const result = await run(tx)
          if (armed) {
            armed = false
            entered.resolve()
            await release.promise
          }
          return result
        })
      }
      return builder
    })
    return {
      entered: entered.promise,
      contended: contended.promise,
      resume: () => release.resolve(),
      restore: () => spy.mockRestore(),
    }
  }
  return {
    db,
    get playerWrites() {
      return playerWrites
    },
    get core() {
      return core
    },
    get owner() {
      return owner
    },
    get actor() {
      return actor
    },
    now,
    tick: () => {
      clock += 1000
    },
    user,
    texture,
    setting,
    balance,
    subscribe,
    events,
    ledger,
    consistent,
    pauseNextCommit,
  }
}
