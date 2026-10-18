import {
  coreMigrations,
  insertReturningId,
  migrateToLatest,
  toIsoTimestamp,
  transactionWithRetry,
  upsert,
  writeAuthDate,
  type CoreDatabase,
} from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import { hashPassword } from 'better-auth/crypto'
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest'
import {
  createCore,
  encodeSettingValue,
  type Core,
  type CoreOptions,
  type CoreSettingKey,
  type CoreSettingValue,
} from '../index.ts'
import { adjustScore } from '../score/adjust.ts'
import type { AuthenticateInput } from './tokens.ts'

export const secretKey = 'test-only-secret-key-with-at-least-32-characters'
export const password = 'correct horse battery staple'
export const email = 'steve@nextskin.test'

export function setup() {
  let database: TestDatabase<CoreDatabase>, core: Core, uid: number, clock: number, hash: string
  const instances: Core[] = []
  const db = () => database.db
  const now = () => new Date(clock)
  // 写进去的文件要能读回来：上传之后会预热出图缓存，读不到就打警告
  const files = new Map<string, Uint8Array>()
  const makeCore = (extra: Partial<CoreOptions> = {}) => {
    const instance = createCore({
      db: db(),
      secretKey,
      production: false,
      now,
      textureStorage: {
        list: () => Promise.resolve([]),
        listTemp: () => Promise.resolve([]),
        lateDeleteWindowMs: 0,
        read: (hash) => Promise.resolve(files.get(hash) ?? null),
        write: (hash, _claimId, bytes) => Promise.resolve(void files.set(hash, bytes)),
        delete: (hash) => Promise.resolve(void files.delete(hash)),
        deleteTemp: () => Promise.resolve(),
      },
      ...extra,
    })
    instances.push(instance)
    return instance
  }
  beforeAll(async () => {
    database = await createTestDatabase<CoreDatabase>()
    await migrateToLatest(db(), coreMigrations)
    hash = await hashPassword(password)
  })
  afterAll(async () => database?.cleanup())
  afterEach(async () => {
    await Promise.all(instances.splice(0).map((instance) => instance.shutdown()))
  })
  async function setting<K extends CoreSettingKey>(key: K, value: CoreSettingValue<K>) {
    await upsert(db(), 'settings', {
      values: {
        namespace: 'core',
        key,
        value: encodeSettingValue(key, value, { secretKey }),
        updated_at: toIsoTimestamp(now()),
      },
      conflict: ['namespace', 'key'],
      update: ['value', 'updated_at'],
    })
  }
  async function user(address = email, credential: string | null = hash) {
    const time = writeAuthDate(db(), toIsoTimestamp(now()))
    const id = await insertReturningId(db(), 'users', {
      nickname: 'Steve',
      email: address,
      email_verified: true,
      locale: 'en',
      created_at: time,
      updated_at: time,
    })
    if (credential !== null)
      await db()
        .insertInto('accounts')
        .values({
          account_id: String(id),
          provider_id: 'credential',
          user_id: id,
          password: credential,
          created_at: time,
          updated_at: time,
        })
        .execute()
    await transactionWithRetry(db(), (tx) =>
      adjustScore(tx, { uid: id, delta: 1000, reason: 'score.reasons.initial', now: toIsoTimestamp(now()) }),
    )
    return id
  }
  beforeEach(async () => {
    await db().deleteFrom('users').execute()
    await db().deleteFrom('textures').execute()
    await db().deleteFrom('texture_files').execute()
    await db().deleteFrom('jobs').execute()
    await db().deleteFrom('settings').execute()
    await db().deleteFrom('verifications').execute()
    clock = Date.now()
    core = makeCore()
    await setting('score.perPlayer', 0)
    await setting('yggdrasil.loginIntervalMs', 0)
    uid = await user()
  })
  const login = (extra: Partial<AuthenticateInput> = {}, instance = core) =>
    instance.yggdrasil.authenticate({
      username: email,
      password,
      rawPassword: password,
      clientToken: null,
      requestUser: false,
      ...extra,
    })
  return {
    db,
    now,
    setting,
    user,
    login,
    makeCore,
    get core() {
      return core
    },
    get uid() {
      return uid
    },
    tick(ms: number) {
      clock += ms
    },
    setTime(time: number) {
      clock = time
    },
    player(name = 'Steve', owner = uid) {
      return core.players.create({ uid: owner }, { name })
    },
  }
}
