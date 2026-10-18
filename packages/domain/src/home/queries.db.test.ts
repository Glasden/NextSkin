import {
  coreMigrations,
  insertReturningId,
  migrateToLatest,
  toIsoTimestamp,
  writeAuthDate,
  type CoreDatabase,
} from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'
import { createCore, type Core } from '../core.ts'

let database: TestDatabase<CoreDatabase>
let core: Core
let current: Date
let users: number[]
let serial = 0
const hash = 'a'.repeat(64)
const iso = (value: string | Date) => toIsoTimestamp(new Date(value))
const timestamp = iso('2026-03-10T02:00:00.000Z')

function makeCore() {
  return createCore({
    db: database.db,
    secretKey: 'home-tests-secret-key-with-at-least-32-characters',
    production: false,
    now: () => current,
    textureStorage: {
      list: () => Promise.resolve([]),
      listTemp: () => Promise.resolve([]),
      lateDeleteWindowMs: 0,
      write: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      deleteTemp: () => Promise.resolve(),
      read: () => Promise.resolve(null),
    },
  })
}
async function user() {
  return insertReturningId(database.db, 'users', {
    nickname: 'User',
    email: `home-${++serial}@example.test`,
    email_verified: false,
    created_at: writeAuthDate(database.db, timestamp),
    updated_at: writeAuthDate(database.db, timestamp),
  })
}
async function texture(
  input: { uploader?: number | null; type?: 'steve' | 'alex' | 'cape'; public?: 0 | 1; likes?: number } = {},
) {
  return insertReturningId(database.db, 'textures', {
    hash,
    name: 'Skin',
    type: input.type ?? 'steve',
    uploader_id: input.uploader === undefined ? users[0]! : input.uploader,
    is_public: input.public ?? 1,
    likes: input.likes ?? 0,
    created_at: timestamp,
    updated_at: timestamp,
  })
}
async function add(tid: number, uid: number, at = timestamp) {
  await database.db
    .insertInto('closet_items')
    .values({
      texture_id: tid,
      user_id: uid,
      name: 'Skin',
      created_at: at,
    })
    .execute()
}

beforeAll(async () => {
  database = await createTestDatabase<CoreDatabase>()
  await migrateToLatest(database.db, coreMigrations)
})
afterAll(async () => database?.cleanup())
afterEach(async () => core.shutdown())
beforeEach(async () => {
  for (const table of ['settings', 'closet_items', 'players', 'textures', 'texture_files', 'users'] as const)
    await database.db.deleteFrom(table).execute()
  current = new Date(timestamp)
  users = []
  for (let i = 0; i < 6; i++) users.push(await user())
  await database.db
    .insertInto('texture_files')
    .values({
      hash,
      pixel_hash: hash,
      width: 128,
      height: 128,
      size_bytes: 1024,
      ref_count: 0,
      status: 'active',
      status_changed_at: timestamp,
      created_at: timestamp,
    })
    .execute()
  core = makeCore()
})

test('排除上传者本人、私有材质和披风；注销上传者的收藏都计入，倍率同皮肤库', async () => {
  const own = await texture()
  const shared = await texture({ type: 'alex' })
  const deletedUploader = await user()
  const orphan = await texture({ uploader: deletedUploader })
  const privateSkin = await texture({ public: 0 })
  const cape = await texture({ type: 'cape' })
  await add(own, users[0]!)
  await add(shared, users[0]!)
  await add(shared, users[1]!)
  await add(orphan, users[0]!)
  await add(orphan, users[1]!)
  await database.db.deleteFrom('users').where('id', '=', deletedUploader).execute()
  await add(privateSkin, users[1]!)
  await add(cape, users[1]!)
  expect(await core.home.podium()).toEqual({
    from: '2026-03-04',
    to: '2026-03-10',
    entries: [
      { tid: orphan, name: 'Skin', type: 'steve', hash, gain: 2, scale: 2 },
      { tid: shared, name: 'Skin', type: 'alex', hash, gain: 1, scale: 2 },
    ],
  })
})

test.each([
  ['Asia/Shanghai', '2026-03-10T02:00:00.000Z', '2026-03-03T16:00:00.000Z', '2026-03-04', '2026-03-10'],
  ['America/New_York', '2026-03-10T02:00:00.000Z', '2026-03-03T05:00:00.000Z', '2026-03-03', '2026-03-09'],
  ['America/New_York', '2026-11-04T02:00:00.000Z', '2026-10-28T04:00:00.000Z', '2026-10-28', '2026-11-03'],
])('区间按 %s 的日历回溯，含起点、排除起点之前和未来（%s）', async (timeZone, now, start, from, to) => {
  current = new Date(now)
  await database.db
    .insertInto('settings')
    .values({
      namespace: 'core',
      key: 'site.timeZone',
      value: JSON.stringify(timeZone),
      updated_at: timestamp,
    })
    .execute()
  const tid = await texture()
  await add(tid, users[1]!, iso(new Date(new Date(start).getTime() - 1)))
  await add(tid, users[2]!, iso(start))
  await add(tid, users[3]!, iso(new Date(new Date(start).getTime() + 1)))
  await add(tid, users[4]!, iso(new Date(current.getTime() + 1)))
  expect(await core.home.podium()).toMatchObject({ from, to, entries: [{ tid, gain: 2 }] })
})

test('先按区间次数，再按 likes、id 倒序，只取三名；非法尺寸回退到标准倍率', async () => {
  const popular = await texture({ likes: 100 })
  const tiedFirst = await texture({ likes: 10 })
  const tiedSecond = await texture({ likes: 10 })
  const winner = await texture({ likes: 0 })
  for (const tid of [popular, tiedFirst, tiedSecond, winner]) await add(tid, users[1]!)
  await add(winner, users[2]!)
  await database.db.updateTable('texture_files').set({ width: 65 }).execute()
  expect((await core.home.podium()).entries.map(({ tid, gain, scale }) => ({ tid, gain, scale }))).toEqual([
    { tid: winner, gain: 2, scale: 1 },
    { tid: popular, gain: 1, scale: 1 },
    { tid: tiedSecond, gain: 1, scale: 1 },
  ])
  await database.db.deleteFrom('closet_items').execute()
  current = new Date(current.getTime() + 60000)
  expect((await core.home.podium()).entries).toEqual([])
})

test('空榜和公开材质、用户、角色统计；两个缓存各自保存 60 秒，并按 core 隔离', async () => {
  const tid = await texture()
  await texture({ public: 0 })
  const firstPodium = await core.home.podium()
  const firstStats = await core.home.stats()
  expect(firstPodium.entries).toEqual([])
  expect(firstStats).toEqual({ textures: 1, users: 6, players: 0 })
  await add(tid, users[1]!)
  await texture({ type: 'cape' })
  const uid = await user()
  await database.db
    .insertInto('players')
    .values({
      user_id: uid,
      name: 'Home',
      name_key: 'home',
      uuid: 'a'.repeat(32),
      created_at: timestamp,
      updated_at: timestamp,
    })
    .execute()
  current = new Date(current.getTime() + 59999)
  expect(await core.home.podium()).toEqual(firstPodium)
  expect(await core.home.stats()).toEqual(firstStats)
  const other = makeCore()
  try {
    expect((await other.home.podium()).entries).toMatchObject([{ tid, gain: 1 }])
    expect(await other.home.stats()).toEqual({ textures: 2, users: 7, players: 1 })
  } finally {
    await other.shutdown()
  }
  current = new Date(current.getTime() + 1)
  expect((await core.home.podium()).entries).toMatchObject([{ tid, gain: 1 }])
  expect(await core.home.stats()).toEqual({ textures: 2, users: 7, players: 1 })
})

test('领奖台缓存不会挡住统计的首次查询', async () => {
  await core.home.podium()
  await texture()
  expect(await core.home.stats()).toEqual({ textures: 1, users: 6, players: 0 })
})
