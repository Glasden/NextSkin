/** 经过核心跑一遍：生成链接、经链接注册、双方得分、事件重投只记一次、名额上限、删除 */
import { coreMigrations, migrateToLatest, toIsoTimestamp, writeAuthDate, type CoreDatabase } from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import { createCore, type Core, type PluginRouteRequest } from '@nextskin/domain'
import { afterAll, beforeAll, expect, test } from 'vitest'
import plugin from './official.ts'

const ID = 'share-registration-link'
const REWARDS = `p_share_registration_link__rewards`
let database: TestDatabase<CoreDatabase>
let core: Core
let admin: { uid: number; ip: string }
let sequence = 0

async function createUser(role: 'user' | 'superadmin') {
  const email = `${role}${++sequence}@example.test`
  const now = writeAuthDate(database.db, toIsoTimestamp(new Date()))
  await database.db
    .insertInto('users')
    .values({ email, nickname: `${role}${sequence}`, role, email_verified: false, created_at: now, updated_at: now })
    .execute()
  const { id } = await database.db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirstOrThrow()
  return { uid: id, ip: '192.0.2.1' }
}

function request(method: string, path: string, user: { uid: number }): PluginRouteRequest {
  return {
    pluginId: ID,
    method,
    path,
    request: { method, url: `https://skin.example.test/plugins/${ID}${path}`, headers: [], body: null },
    user: { uid: user.uid, role: user === admin ? 'superadmin' : 'user' },
    ip: '192.0.2.1',
    locale: 'en',
  }
}

interface LinkRow {
  code: string
  link: string
  registrations: number
}

async function links(user: { uid: number }): Promise<LinkRow[]> {
  const response = await core.plugins.route(request('GET', '/codes', user))
  expect(response.status).toBe(200)
  return (JSON.parse(new TextDecoder().decode(response.body)) as { rows: LinkRow[] }).rows
}

async function generate(user: { uid: number }): Promise<LinkRow> {
  const before = await links(user)
  const response = await core.plugins.route(request('POST', '/codes', user))
  expect(response.status).toBe(201)
  const created = (await links(user)).find((row) => !before.some((old) => old.code === row.code))
  if (!created) throw new Error('没有生成新的链接')
  return created
}

let registrations = 0
function register(code?: string) {
  const n = ++registrations
  return core.users.register({
    email: `player${n}@example.test`,
    password: 'correct horse battery staple',
    playerName: `Player${n}`,
    ip: `198.51.100.${n}`,
    locale: 'en',
    ...(code === undefined ? {} : { plugins: { [ID]: { code } } }),
  })
}

/** 插件写的流水：(uid, delta, reason, key) */
async function pluginScore(uid: number) {
  return database.db
    .selectFrom('score_transactions')
    .select(['delta', 'reason', 'plugin_key'])
    .where('user_id', '=', uid)
    .where('plugin_id', '=', ID)
    .orderBy('id')
    .execute()
}

async function settings(values: { sharerScore: number; shareeScore: number; maxRewardsPerSharer: number }) {
  await core.plugins.admin.updateSettings(admin, ID, values)
}

beforeAll(async () => {
  database = await createTestDatabase<CoreDatabase>()
  await migrateToLatest(database.db, coreMigrations)
  core = createCore({
    db: database.db,
    secretKey: 'share-registration-link-test-secret-key-32-characters',
    production: false,
    textureStorage: {
      list: () => Promise.resolve([]),
      listTemp: () => Promise.resolve([]),
      lateDeleteWindowMs: 0,
      write: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      deleteTemp: () => Promise.resolve(),
      read: () => Promise.resolve(null),
    },
    plugins: {
      official: [plugin],
      sqliteFile: database.config.dialect === 'sqlite' ? database.config.file : undefined,
      log: () => {},
    },
    jobs: { log: () => {} },
  })
  await core.plugins.start()
  admin = await createUser('superadmin')
  await core.plugins.admin.enable(admin, ID)
})
afterAll(async () => {
  await core?.shutdown()
  await database?.cleanup()
})

test('生成的链接带上插件 id 和分享码；新用户经链接注册后双方得分', async () => {
  await settings({ sharerScore: 50, shareeScore: 10, maxRewardsPerSharer: 0 })
  const sharer = await createUser('user')
  const row = await generate(sharer)
  expect(row.link).toBe(`https://skin.example.test/sign-up?${ID}.code=${row.code}`)
  expect(row.registrations).toBe(0)

  // 用户手输时大小写和分隔符随意
  const { uid } = await register(`${row.code.slice(0, 8).toLowerCase()}-${row.code.slice(8)}`)
  await core.jobs.drain()
  expect(await pluginScore(sharer.uid)).toEqual([{ delta: 50, reason: 'score.sharer', plugin_key: `sharer:${uid}` }])
  expect(await pluginScore(uid)).toEqual([{ delta: 10, reason: 'score.sharee', plugin_key: `sharee:${uid}` }])
  expect((await links(sharer))[0]).toMatchObject({ code: row.code, registrations: 1 })
})

test('事件重投只记一次分；中途改了设置，重投仍按第一次记下的分数', async () => {
  await settings({ sharerScore: 50, shareeScore: 0, maxRewardsPerSharer: 0 })
  const sharer = await createUser('user')
  const { code } = await generate(sharer)
  const { uid } = await register(code)
  const job = await database.db
    .selectFrom('jobs')
    .select(['name', 'payload'])
    .where('name', '=', `plugin:${ID}:on:user.registered`)
    .executeTakeFirstOrThrow()
  await core.jobs.drain()
  await settings({ sharerScore: 70, shareeScore: 5, maxRewardsPerSharer: 0 })
  const now = toIsoTimestamp(new Date())
  await database.db
    .insertInto('jobs')
    .values({ ...job, dedupe_key: null, run_at: now, created_at: now })
    .execute()
  await core.jobs.drain()
  expect(await pluginScore(sharer.uid)).toEqual([{ delta: 50, reason: 'score.sharer', plugin_key: `sharer:${uid}` }])
  // 新用户那一笔是 0 分，不调用
  expect(await pluginScore(uid)).toEqual([])
})

test('分享码无效时照样注册，只是没有奖励', async () => {
  const { uid } = await register('NOT-A-REAL-CODE')
  await core.jobs.drain()
  expect(await pluginScore(uid)).toEqual([])
})

test('每个分享人最多得几次奖励：到了次数照常注册，双方都不再得分', async () => {
  await settings({ sharerScore: 50, shareeScore: 10, maxRewardsPerSharer: 1 })
  const sharer = await createUser('user')
  const { code } = await generate(sharer)
  const first = await register(code)
  await core.jobs.drain()
  const second = await register(code)
  await core.jobs.drain()
  expect(await pluginScore(sharer.uid)).toEqual([
    { delta: 50, reason: 'score.sharer', plugin_key: `sharer:${first.uid}` },
  ])
  expect(await pluginScore(second.uid)).toEqual([])
  const rewards = await database.db
    .withTables<{ [REWARDS]: { sharee_uid: number; state: string; slot: number | null } }>()
    .selectFrom(REWARDS)
    .select(['sharee_uid', 'state', 'slot'])
    .where('sharee_uid', 'in', [first.uid, second.uid])
    .orderBy('sharee_uid')
    .execute()
  expect(rewards).toEqual([
    { sharee_uid: first.uid, state: 'granted', slot: 1 },
    { sharee_uid: second.uid, state: 'capped', slot: null },
  ])
  // 名额满了的链接，注册人数照样算
  expect((await links(sharer))[0]).toMatchObject({ registrations: 2 })
})

test('每人最多 10 个链接；只能删自己的；删掉的用户的链接一起删', async () => {
  const owner = await createUser('user')
  const other = await createUser('user')
  for (let i = 0; i < 10; i++) await generate(owner)
  const full = await core.plugins.route(request('POST', '/codes', owner))
  expect(full.status).toBe(409)
  const [first] = await links(owner)
  const path = `/codes/${first!.code}`
  expect((await core.plugins.route(request('DELETE', path, other))).status).toBe(204)
  expect(await links(owner)).toHaveLength(10)
  expect((await core.plugins.route(request('DELETE', path, owner))).status).toBe(204)
  expect(await links(owner)).toHaveLength(9)

  await core.admin.deleteUser(admin, owner.uid, { publicTextures: 'keep' })
  await core.jobs.drain()
  const left = await database.db
    .withTables<{ p_share_registration_link__codes: { uid: number } }>()
    .selectFrom('p_share_registration_link__codes')
    .select('uid')
    .where('uid', '=', owner.uid)
    .execute()
  expect(left).toEqual([])
})
