import { sql, type Insertable, type Kysely, type Selectable } from 'kysely'
import { afterAll, beforeAll, beforeEach, expect, expectTypeOf, test } from 'vitest'
import {
  coreMigrations,
  insertReturningId,
  migrateToLatest,
  readAuthBoolean,
  readAuthDate,
  toIsoTimestamp,
  writeAuthDate,
  type CoreDatabase,
  type IsoTimestamp,
  type SwitchValue,
  type TextureFileStatus,
  type TextureType,
  type UserRole,
  type UsersTable,
} from './index.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

const timestamp = toIsoTimestamp(new Date('2040-02-29T23:59:59.123Z'))
const hash = 'a'.repeat(64)
const uuid = '0123456789abcdef0123456789abcdef'
const file = {
  hash,
  pixel_hash: 'b'.repeat(64),
  width: 64,
  height: 64,
  size_bytes: 1024,
  ref_count: 2,
  status: 'active',
  claim_id: '12345678-1234-4234-8234-123456789abc',
  status_changed_at: timestamp,
  delete_attempted_at: null,
  delete_confirmed_at: null,
  created_at: timestamp,
} satisfies Insertable<CoreDatabase['texture_files']>
const setting = { namespace: 'core', key: 'site_name', value: '"NextSkin"', updated_at: timestamp }
let database: TestDatabase<CoreDatabase>
let db: Kysely<CoreDatabase>
let appliedMigrations: string[]
let userId: number
let skinId: number
let capeId: number
let playerId: number

function user(): Insertable<UsersTable> {
  return {
    nickname: '测试用户',
    email: 'alice@example.test',
    email_verified: true,
    image: 'https://example.test/avatar.png',
    two_factor_enabled: false,
    created_at: writeAuthDate(db, timestamp),
    updated_at: writeAuthDate(db, timestamp),
    locale: 'zh-CN',
    registration_ip: '2001:db8::1',
    last_check_in_at: timestamp,
  }
}

function texture(type: TextureType): Insertable<CoreDatabase['textures']> {
  return {
    hash,
    name: `测试材质 ${type}`,
    type,
    description: '材质说明',
    uploader_id: userId,
    is_public: type === 'cape' ? 0 : 1,
    created_at: timestamp,
    updated_at: timestamp,
  }
}

function player(): Insertable<CoreDatabase['players']> {
  return {
    user_id: userId,
    name: 'Alice',
    name_key: 'alice',
    uuid,
    skin_texture_id: skinId,
    cape_texture_id: capeId,
    created_at: timestamp,
    updated_at: timestamp,
  }
}

beforeAll(async () => {
  database = await createTestDatabase<CoreDatabase>()
  db = database.db
  appliedMigrations = await migrateToLatest(db, coreMigrations)
})
afterAll(async () => database?.cleanup())
beforeEach(async () => {
  await db.deleteFrom('jobs').execute()
  await db.deleteFrom('failed_jobs').execute()
  await db.deleteFrom('settings').execute()
  await db.deleteFrom('players').execute()
  await db.deleteFrom('users').execute()
  await db.deleteFrom('textures').execute()
  await db.deleteFrom('texture_files').execute()
  userId = await insertReturningId(db, 'users', user())
  await db.insertInto('texture_files').values(file).execute()
  skinId = await insertReturningId(db, 'textures', texture('alex'))
  capeId = await insertReturningId(db, 'textures', texture('cape'))
  await db.updateTable('users').set({ avatar_texture_id: skinId }).where('id', '=', userId).execute()
  playerId = await insertReturningId(db, 'players', player())
  await db.insertInto('settings').values(setting).execute()
})

test('核心迁移按顺序执行一次，重复执行返回空数组', async () => {
  expect(appliedMigrations).toEqual([
    '0001_create_users',
    '0002_create_texture_files',
    '0003_create_textures',
    '0004_add_users_avatar_texture_id',
    '0005_create_players',
    '0006_create_settings',
    '0007_create_sessions',
    '0008_create_accounts',
    '0009_create_verifications',
    '0010_create_jwks',
    '0011_create_oauth_clients',
    '0012_create_oauth_resources',
    '0013_create_oauth_client_resources',
    '0014_create_oauth_refresh_tokens',
    '0015_create_oauth_access_tokens',
    '0016_create_oauth_consents',
    '0017_create_oauth_client_assertions',
    '0018_create_device_codes',
    '0019_create_two_factors',
    '0020_create_passkeys',
    '0021_create_device_code_selections',
    '0022_create_jobs',
    '0023_create_failed_jobs',
    '0024_create_score_transactions',
    '0025_add_players_score_paid',
    '0026_add_users_email_version',
  ])
  expect(await migrateToLatest(db, coreMigrations)).toEqual([])
})

test('类型化写入完整引用关系，读回各列、默认值和认证字段', async () => {
  const row = await db.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirstOrThrow()
  expect({
    ...row,
    created_at: readAuthDate(row.created_at),
    updated_at: readAuthDate(row.updated_at),
    email_verified: readAuthBoolean(row.email_verified),
    two_factor_enabled: readAuthBoolean(row.two_factor_enabled),
  }).toEqual({
    ...user(),
    id: userId,
    avatar_texture_id: skinId,
    role: 'user',
    score: 0,
    email_version: 0,
    created_at: timestamp,
    updated_at: timestamp,
  })
  expect(await db.selectFrom('texture_files').selectAll().execute()).toEqual([file])
  expect(await db.selectFrom('textures').selectAll().orderBy('id').execute()).toEqual([
    { ...texture('alex'), id: skinId, likes: 0 },
    { ...texture('cape'), id: capeId, likes: 0 },
  ])
  expect(await db.selectFrom('players').selectAll().execute()).toEqual([{ ...player(), id: playerId, score_paid: 0 }])
  expect(await db.selectFrom('settings').selectAll().where('key', '=', setting.key).execute()).toEqual([setting])

  expectTypeOf(row.created_at).toEqualTypeOf<Date | string>()
  expectTypeOf(row.email_verified).toEqualTypeOf<boolean | number>()
  expectTypeOf<Insertable<UsersTable>['email_verified']>().toEqualTypeOf<boolean>()
  expectTypeOf<Insertable<UsersTable>['two_factor_enabled']>().toEqualTypeOf<boolean | null | undefined>()
  expectTypeOf<Selectable<CoreDatabase['textures']>['is_public']>().toEqualTypeOf<SwitchValue>()
  expectTypeOf<Selectable<CoreDatabase['players']>['updated_at']>().toEqualTypeOf<IsoTimestamp>()
})

test('用户领域字段均可省略，认证可空字段保留 NULL', async () => {
  const id = await insertReturningId(db, 'users', {
    nickname: '最小用户',
    email: 'minimal@example.test',
    email_verified: false,
    created_at: writeAuthDate(db, timestamp),
    updated_at: writeAuthDate(db, timestamp),
  })
  const row = await db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
  expect(row).toMatchObject({
    role: 'user',
    score: 0,
    email_version: 0,
    avatar_texture_id: null,
    image: null,
    two_factor_enabled: null,
    locale: null,
    registration_ip: null,
    last_check_in_at: null,
  })
  expect(readAuthBoolean(row.email_verified)).toBe(false)
})

test('有限字符串、非负引用计数和开关的 CHECK 拒绝非法值', async () => {
  // 故意绕过类型约束，验证数据库本身会拒绝这些值。
  await expect(
    db
      .updateTable('users')
      .set({ role: 'root' as UserRole })
      .execute(),
  ).rejects.toThrow()
  await expect(
    db
      .updateTable('texture_files')
      .set({ status: 'gone' as TextureFileStatus })
      .execute(),
  ).rejects.toThrow()
  await expect(
    db
      .updateTable('textures')
      .set({ type: 'elytra' as TextureType })
      .execute(),
  ).rejects.toThrow()
  await expect(db.updateTable('texture_files').set({ ref_count: -1 }).execute()).rejects.toThrow()
  await expect(
    db
      .updateTable('textures')
      .set({ is_public: 2 as SwitchValue })
      .execute(),
  ).rejects.toThrow()
})

test.each(['pixel_hash', 'width', 'height', 'size_bytes'] as const)('active 文件缺少 %s 时被拒绝', async (column) => {
  await expect(
    db
      .updateTable('texture_files')
      .set({ [column]: null })
      .execute(),
  ).rejects.toThrow()
})

test.each(['pending', 'deleting'] as const)('%s 文件允许元数据为空', async (status) => {
  const value = { ...file, status, pixel_hash: null, width: null, height: null, size_bytes: null, ref_count: 0 }
  await db.updateTable('texture_files').set(value).where('hash', '=', hash).execute()
  expect(await db.selectFrom('texture_files').selectAll().execute()).toEqual([value])
})

test.each([
  ['users', 'last_check_in_at'],
  ['texture_files', 'status_changed_at'],
  ['texture_files', 'delete_attempted_at'],
  ['texture_files', 'delete_confirmed_at'],
  ['texture_files', 'created_at'],
  ['textures', 'created_at'],
  ['textures', 'updated_at'],
  ['players', 'created_at'],
  ['players', 'updated_at'],
  ['settings', 'updated_at'],
])('%s.%s 拒绝非法 ISO 时间格式', async (table, column) => {
  await expect(
    sql`update ${sql.table(table)} set ${sql.ref(column)} = ${'2040-02-29 23:59:59.123Z'}`.execute(db),
  ).rejects.toThrow()
})

test('邮箱、角色规范化名、UUID 和设置复合主键分别拒绝重复值', async () => {
  await expect(db.insertInto('users').values(user()).execute()).rejects.toThrow()
  await expect(
    db
      .insertInto('players')
      .values({ ...player(), uuid: '1'.repeat(32) })
      .execute(),
  ).rejects.toThrow()
  await expect(
    db
      .insertInto('players')
      .values({ ...player(), name_key: 'other' })
      .execute(),
  ).rejects.toThrow()
  await expect(db.insertInto('settings').values(setting).execute()).rejects.toThrow()
})

test('文件的文本主键拒绝 NULL 和重复值', async () => {
  await expect(
    db
      .insertInto('texture_files')
      .values({ ...file, hash: sql<string>`null` })
      .execute(),
  ).rejects.toThrow()
  await expect(db.insertInto('texture_files').values(file).execute()).rejects.toThrow()
})

test('显示名不唯一，设置仅要求 namespace 和 key 的组合唯一，像素 hash 不唯一', async () => {
  const id = await insertReturningId(db, 'players', { ...player(), name_key: 'ALICE', uuid: '1'.repeat(32) })
  expect(await db.selectFrom('players').select('name').where('id', '=', id).executeTakeFirstOrThrow()).toEqual({
    name: 'Alice',
  })
  const settings = [
    { ...setting, namespace: 'plugin:example' },
    { ...setting, key: 'another_key' },
  ]
  await db.insertInto('settings').values(settings).execute()
  expect(await db.selectFrom('settings').selectAll().execute()).toHaveLength(3)
  await db
    .insertInto('texture_files')
    .values({ ...file, hash: 'c'.repeat(64) })
    .execute()
  expect(
    await db.selectFrom('texture_files').selectAll().where('pixel_hash', '=', file.pixel_hash).execute(),
  ).toHaveLength(2)
})

test('被材质引用的文件不能删除（restrict）', async () => {
  await expect(db.deleteFrom('texture_files').where('hash', '=', hash).execute()).rejects.toThrow()
  expect(await db.selectFrom('texture_files').selectAll().execute()).toEqual([file])
})

test('删除材质将角色皮肤、披风及用户头像外键置空', async () => {
  await db.deleteFrom('textures').where('id', 'in', [skinId, capeId]).execute()
  expect(await db.selectFrom('players').selectAll().execute()).toEqual([
    { ...player(), id: playerId, score_paid: 0, skin_texture_id: null, cape_texture_id: null },
  ])
  expect(
    await db.selectFrom('users').select('avatar_texture_id').where('id', '=', userId).executeTakeFirstOrThrow(),
  ).toEqual({ avatar_texture_id: null })
})

test('删除用户级联删除其角色，同时保留材质并将上传者置空', async () => {
  await db.deleteFrom('users').where('id', '=', userId).execute()
  expect(await db.selectFrom('players').selectAll().execute()).toEqual([])
  expect(await db.selectFrom('textures').selectAll().orderBy('id').execute()).toEqual([
    { ...texture('alex'), id: skinId, likes: 0, uploader_id: null },
    { ...texture('cape'), id: capeId, likes: 0, uploader_id: null },
  ])
})

test('角色不能引用不存在的用户', async () => {
  await expect(
    db
      .insertInto('players')
      .values({ ...player(), user_id: 2147483647, name_key: 'orphan', uuid: '2'.repeat(32) })
      .execute(),
  ).rejects.toThrow()
})

test('settings.value 无损读写七万字节的字符串', async () => {
  const value = '汉'.repeat(23_333) + '!'
  expect(Buffer.byteLength(value)).toBe(70_000)
  await db
    .updateTable('settings')
    .set({ value })
    .where('namespace', '=', 'core')
    .where('key', '=', setting.key)
    .execute()
  expect(
    (
      await db
        .selectFrom('settings')
        .selectAll()
        .where('namespace', '=', 'core')
        .where('key', '=', setting.key)
        .executeTakeFirstOrThrow()
    ).value,
  ).toBe(value)
})

test('任务、死信和积分流水的列与 schema 一致', async () => {
  const tables = await db.introspection.getTables()
  const columns = {
    jobs: ['id', 'name', 'payload', 'dedupe_key', 'run_at', 'lease_id', 'attempts', 'last_error', 'created_at'],
    failed_jobs: ['id', 'name', 'payload', 'dedupe_key', 'attempts', 'last_error', 'created_at', 'failed_at'],
    score_transactions: ['id', 'user_id', 'delta', 'balance', 'reason', 'subject_type', 'subject_id', 'created_at'],
  }
  for (const [name, expected] of Object.entries(columns)) {
    const table = tables.find((table) => table.name === name)!
    expect(table.columns.map((column) => column.name).sort()).toEqual([...expected].sort())
    const nullable =
      name === 'jobs'
        ? ['dedupe_key', 'lease_id', 'last_error']
        : name === 'failed_jobs'
          ? ['dedupe_key', 'last_error']
          : ['subject_type', 'subject_id']
    expect(
      table.columns
        .filter((column) => column.name !== 'id' && column.isNullable)
        .map((column) => column.name)
        .sort(),
    ).toEqual(nullable.sort())
  }
})

test('任务默认次数为零，去重仅限制相同任务名和非空键的组合', async () => {
  const job = { name: 'core:test', payload: '{}', run_at: timestamp, created_at: timestamp }
  const id = await insertReturningId(db, 'jobs', { ...job, dedupe_key: 'same' })
  expect(await db.selectFrom('jobs').selectAll().where('id', '=', id).executeTakeFirstOrThrow()).toEqual({
    ...job,
    id,
    dedupe_key: 'same',
    lease_id: null,
    last_error: null,
    attempts: 0,
  })
  await expect(
    db
      .insertInto('jobs')
      .values({ ...job, dedupe_key: 'same' })
      .execute(),
  ).rejects.toThrow()
  await db
    .insertInto('jobs')
    .values([{ ...job, name: 'other', dedupe_key: 'same' }, job, job])
    .execute()
  expect(await db.selectFrom('jobs').select('id').execute()).toHaveLength(4)
})

test('死信不限制重复键，两张任务表都能存放超过 64 KB 的载荷', async () => {
  const payload = '汉'.repeat(25_000)
  const dead = {
    name: 'core:test',
    payload,
    dedupe_key: 'same',
    attempts: 3,
    last_error: null,
    created_at: timestamp,
    failed_at: timestamp,
  }
  await db.insertInto('failed_jobs').values([dead, dead]).execute()
  expect(
    (await db.selectFrom('failed_jobs').selectAll().orderBy('id').execute()).map(({ id, ...row }) => {
      expect(id).toBeGreaterThan(0)
      return row
    }),
  ).toEqual([dead, dead])
  await db.insertInto('jobs').values({ name: 'core:test', payload, run_at: timestamp, created_at: timestamp }).execute()
  expect((await db.selectFrom('jobs').select('payload').executeTakeFirstOrThrow()).payload).toBe(payload)
})

test('积分流水保留非外键的关联对象，删除用户时级联删除流水', async () => {
  const row = {
    user_id: userId,
    delta: 10,
    balance: 10,
    reason: 'score.reasons.initial',
    subject_type: 'future_subject',
    subject_id: 2147483647,
    created_at: timestamp,
  }
  const id = await insertReturningId(db, 'score_transactions', row)
  expect(await db.selectFrom('score_transactions').selectAll().executeTakeFirstOrThrow()).toEqual({ ...row, id })
  await expect(
    db
      .insertInto('score_transactions')
      .values({ ...row, user_id: 2147483647 })
      .execute(),
  ).rejects.toThrow()
  await db.deleteFrom('users').where('id', '=', userId).execute()
  expect(await db.selectFrom('score_transactions').selectAll().execute()).toEqual([])
})

test('角色实付积分列默认 0，且拒绝 null', async () => {
  expect(
    (await db.selectFrom('players').select('score_paid').where('id', '=', playerId).executeTakeFirstOrThrow())
      .score_paid,
  ).toBe(0)
  await expect(
    db
      .updateTable('players')
      .set({ score_paid: null as unknown as number })
      .where('id', '=', playerId)
      .execute(),
  ).rejects.toThrow()
})

test('邮箱版本迁移为已有用户和新用户补 0，拒绝 NULL，自增表达式只加一次', async () => {
  const upgrade = await createTestDatabase<CoreDatabase>()
  try {
    const previous = Object.fromEntries(
      Object.entries(coreMigrations).filter(([name]) => name < '0026_add_users_email_version'),
    )
    await migrateToLatest(upgrade.db, previous)
    const now = writeAuthDate(upgrade.db, timestamp)
    const values = {
      nickname: '升级前的用户',
      email: 'before@example.test',
      email_verified: false,
      created_at: now,
      updated_at: now,
    }
    const existing = await insertReturningId(upgrade.db, 'users', values)
    expect(await migrateToLatest(upgrade.db, coreMigrations)).toEqual(['0026_add_users_email_version'])
    const added = await insertReturningId(upgrade.db, 'users', { ...values, email: 'after@example.test' })
    const version = async (uid: number) =>
      (await upgrade.db.selectFrom('users').select('email_version').where('id', '=', uid).executeTakeFirstOrThrow())
        .email_version
    expect(await version(existing)).toBe(0)
    expect(await version(added)).toBe(0)
    for (const [email, expected] of [
      ['new@example.test', 1],
      ['before@example.test', 2],
    ] as const) {
      await upgrade.db
        .updateTable('users')
        .set((eb) => ({ email, email_version: eb('email_version', '+', 1) }))
        .where('id', '=', existing)
        .execute()
      expect(await version(existing)).toBe(expected)
      expect(await version(added)).toBe(0)
    }
    await expect(
      upgrade.db
        .updateTable('users')
        .set({ email_version: null as unknown as number })
        .where('id', '=', existing)
        .execute(),
    ).rejects.toThrow()
  } finally {
    await upgrade.cleanup()
  }
})
