/** 经过核心跑一遍：启用、迁移、生成、注册时用掉、事件记下用户、列表和删除 */
import { coreMigrations, migrateToLatest, toIsoTimestamp, writeAuthDate, type CoreDatabase } from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import { createCore, type Core, type PluginRouteRequest } from '@nextskin/domain'
import { afterAll, beforeAll, expect, test } from 'vitest'
import plugin from './official.ts'

const TABLE = 'p_invitation_codes__codes'
let database: TestDatabase<CoreDatabase>
let core: Core
let admin: { uid: number; ip: string }
let sequence = 0

async function createUser(role: 'user' | 'superadmin') {
  const email = `${role}${++sequence}@example.test`
  const now = writeAuthDate(database.db, toIsoTimestamp(new Date()))
  await database.db
    .insertInto('users')
    .values({ email, nickname: role, role, email_verified: false, created_at: now, updated_at: now })
    .execute()
  const { id } = await database.db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirstOrThrow()
  return { uid: id, ip: '192.0.2.1' }
}

function request(method: string, path: string, user: { uid: number } | null, body?: unknown): PluginRouteRequest {
  const url = `https://skin.example.test/plugins/invitation-codes${path}`
  return {
    pluginId: 'invitation-codes',
    method,
    path: path.split('?')[0]!,
    request: {
      method,
      url,
      headers: body === undefined ? [] : [['content-type', 'application/json']],
      body: body === undefined ? null : new TextEncoder().encode(JSON.stringify(body)),
    },
    user: user ? { uid: user.uid, role: user === admin ? 'superadmin' : 'user' } : null,
    ip: '192.0.2.1',
    locale: 'en',
  }
}

async function json(response: { status: number; body: Uint8Array | null }) {
  return {
    status: response.status,
    body: response.body ? (JSON.parse(new TextDecoder().decode(response.body)) as unknown) : null,
  }
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
    ...(code === undefined ? {} : { plugins: { 'invitation-codes': { code } } }),
  })
}

beforeAll(async () => {
  database = await createTestDatabase<CoreDatabase>()
  await migrateToLatest(database.db, coreMigrations)
  core = createCore({
    db: database.db,
    secretKey: 'invitation-codes-test-secret-key-at-least-32-characters',
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
  await core.plugins.admin.enable(admin, 'invitation-codes')
})
afterAll(async () => {
  await core?.shutdown()
  await database?.cleanup()
})

async function generate(count: number) {
  const response = await json(await core.plugins.route(request('POST', '/codes', admin, { count })))
  expect(response).toEqual({ status: 201, body: { created: count } })
  const rows = await database.db
    .withTables<{ [TABLE]: { code: string; created_at: string } }>()
    .selectFrom(TABLE)
    .select('code')
    .orderBy('code')
    .execute()
  return rows.map((row) => row.code)
}

test('没填邀请码：invalid_request，出错的是插件的字段', async () => {
  await expect(register()).rejects.toMatchObject({ code: 'invalid_request', fields: ['invitation-codes.code'] })
})

test('邀请码无效：拒绝注册，用户没建出来', async () => {
  await expect(register('NOPE')).rejects.toMatchObject({
    code: 'registration_denied',
    params: { plugin: 'invitation-codes', reason: 'invalid_code' },
  })
  expect(await database.db.selectFrom('users').select('email').where('email', 'like', 'player%').execute()).toEqual([])
})

test('生成、用掉、记下用户；同一个码不能再用', async () => {
  const [code] = await generate(1)
  const { uid } = await register(`${code!.slice(0, 6).toLowerCase()}-${code!.slice(6)}`)
  await core.jobs.drain()
  const row = await database.db
    .withTables<{ [TABLE]: { code: string; status: string; used_by: number | null; used_at: string | null } }>()
    .selectFrom(TABLE)
    .selectAll()
    .where('code', '=', code!)
    .executeTakeFirstOrThrow()
  expect(row).toMatchObject({ status: 'used', used_by: uid })
  expect(row.used_at).not.toBeNull()
  await expect(register(code)).rejects.toMatchObject({ code: 'registration_denied' })
})

test('过期的码不能用', async () => {
  const now = new Date().toISOString()
  await database.db
    .withTables<{ [TABLE]: Record<string, string | number | null> }>()
    .insertInto(TABLE)
    .values({
      code: 'EXPIREDCODE2',
      status: 'unused',
      used_by: null,
      used_at: null,
      created_by: admin.uid,
      created_at: now,
      expires_at: '2000-01-01T00:00:00.000Z',
    })
    .execute()
  await expect(register('EXPIREDCODE2')).rejects.toMatchObject({ code: 'registration_denied' })
})

test('列表：分页、搜索、状态是本地化的文字', async () => {
  const codes = await generate(3)
  const page = await json(await core.plugins.route(request('GET', '/codes?page=1&pageSize=2', admin)))
  expect(page.status).toBe(200)
  const body = page.body as { rows: { code: string; status: string }[]; total: number }
  expect(body.rows).toHaveLength(2)
  expect(body.total).toBe(codes.length)
  const target = codes.find((code) => code !== 'EXPIREDCODE2')!
  const search = await json(
    await core.plugins.route(request('GET', `/codes?q=${target.slice(2, 8).toLowerCase()}`, admin)),
  )
  expect((search.body as typeof body).rows.map((row) => row.code)).toContain(target)
  const expired = await json(await core.plugins.route(request('GET', '/codes?q=EXPIREDCODE2', admin)))
  expect((expired.body as typeof body).rows).toEqual([
    expect.objectContaining({ code: 'EXPIREDCODE2', status: 'Expired' }),
  ])
})

test('普通用户看不到列表；删除后码就没了', async () => {
  const user = await createUser('user')
  await expect(core.plugins.route(request('GET', '/codes', user))).rejects.toMatchObject({ code: 'permission_denied' })
  const response = await core.plugins.route(request('DELETE', '/codes/EXPIREDCODE2', admin))
  expect(response.status).toBe(204)
  const left = await json(await core.plugins.route(request('GET', '/codes?q=EXPIREDCODE2', admin)))
  expect((left.body as { total: number }).total).toBe(0)
})

test('停用后注册不再要邀请码', async () => {
  await core.plugins.admin.disable(admin, 'invitation-codes')
  await expect(register()).resolves.toHaveProperty('uid')
  await core.plugins.admin.enable(admin, 'invitation-codes')
})
