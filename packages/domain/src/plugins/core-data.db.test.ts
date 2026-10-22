import { coreMigrations, migrateToLatest, toIsoTimestamp, writeAuthDate, type CoreDatabase } from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createPluginCoreData, type PluginCoreData } from './core-data.ts'

let database: TestDatabase<CoreDatabase>
let data: PluginCoreData
const uids = new Map<string, number>()

beforeAll(async () => {
  database = await createTestDatabase<CoreDatabase>()
  await migrateToLatest(database.db, coreMigrations)
  data = createPluginCoreData(database.db, {
    list: () => Promise.resolve([]),
    listTemp: () => Promise.resolve([]),
    lateDeleteWindowMs: 0,
    write: async () => {},
    delete: async () => {},
    deleteTemp: async () => {},
    read: () => Promise.resolve(null),
  })
  const now = writeAuthDate(database.db, toIsoTimestamp(new Date('2026-10-21T00:00:00.000Z')))
  // 插入顺序就是 uid 的顺序
  for (const [n, nickname] of ['Steve', 'steven', 'Alex', 'STEVE_2', '100%', 'a_b', '小明'].entries()) {
    const email = `user${n}@example.test`
    await database.db
      .insertInto('users')
      .values({ email, nickname, role: 'user', email_verified: true, created_at: now, updated_at: now })
      .execute()
    const row = await database.db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirstOrThrow()
    uids.set(nickname, row.id)
  }
})
afterAll(async () => database?.cleanup())

const search = (query: unknown, after?: unknown, limit?: unknown, privateFields = false) =>
  data.usersByNickname(query, after, limit, privateFields)
const nicknames = async (...args: Parameters<typeof search>) => (await search(...args)).map((user) => user.nickname)

test('昵称包含搜索词就命中，ASCII 不分大小写，按 uid 升序', async () => {
  expect(await nicknames('steve')).toEqual(['Steve', 'steven', 'STEVE_2'])
  expect(await nicknames('EVEN')).toEqual(['steven'])
  expect(await nicknames('明')).toEqual(['小明'])
  expect(await nicknames('nobody')).toEqual([])
})

test('% 和 _ 按字面匹配，不 trim', async () => {
  expect(await nicknames('%')).toEqual(['100%'])
  expect(await nicknames('_')).toEqual(['STEVE_2', 'a_b'])
  expect(await nicknames(' steve')).toEqual([])
})

test('after 取上一页最后一个 uid，limit 默认 100', async () => {
  const first = await search('steve', undefined, 2)
  expect(first.map((user) => user.nickname)).toEqual(['Steve', 'steven'])
  expect(await nicknames('steve', first.at(-1)!.uid, 2)).toEqual(['STEVE_2'])
  expect(await nicknames('steve', uids.get('STEVE_2'))).toEqual([])
  expect(await nicknames('e', undefined, 100)).toEqual(['Steve', 'steven', 'Alex', 'STEVE_2'])
})

test('能力决定返回公开还是私有 DTO', async () => {
  const [open] = await search('Alex')
  expect(open).toEqual({
    uid: uids.get('Alex'),
    nickname: 'Alex',
    role: 'user',
    avatarTid: null,
    registeredAt: '2026-10-21T00:00:00.000Z',
  })
  const [full] = await search('Alex', undefined, undefined, true)
  expect(full).toMatchObject({ uid: uids.get('Alex'), email: 'user2@example.test', emailVerified: true })
})

test('带 NUL 的搜索词返回空数组：昵称里不会有 NUL', async () => {
  expect(await search('Ste\0ve')).toEqual([])
})

test.each<[string, unknown[]]>([
  ['空串', ['']],
  ['超过 255 个字符', ['a'.repeat(256)]],
  ['不是字符串', [1]],
  ['after 不是正整数', ['a', 0]],
  ['after 是小数', ['a', 1.5]],
  ['limit 是 0', ['a', undefined, 0]],
  ['limit 超过 100', ['a', undefined, 101]],
  ['limit 不是整数', ['a', undefined, '10']],
])('参数不对就拒绝：%s', async (_, [query, after, limit]) => {
  await expect(search(query, after, limit)).rejects.toMatchObject({ name: 'PluginCallRejected' })
})
