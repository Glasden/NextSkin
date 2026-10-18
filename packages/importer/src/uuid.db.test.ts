// UUID 是迁移中后果最严重的一项（ADR-0006）：两类候选值、大小写、旧格式、冲突、指定、两种生成算法都有专门的用例
import { coreMigrations, dialectOf, migrateToLatest, type CoreDatabase } from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import { offlineUuid } from '@nextskin/domain/importer'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'
import type { SourceDatabase } from './source/schema.ts'
import { createBsSchema, insertRows, type BsSchemaOptions } from './testing/bs.ts'
import { createEnvironment, importer, type Environment } from './testing/fixtures.ts'

let env: Environment
let source: TestDatabase<SourceDatabase>
let target: TestDatabase<CoreDatabase>
let run: ReturnType<typeof importer>

beforeAll(async () => {
  env = await createEnvironment()
})
afterAll(async () => env?.cleanup())
beforeEach(async () => {
  await env.resetStorage()
  source = await createTestDatabase<SourceDatabase>()
  target = await createTestDatabase<CoreDatabase>()
  await migrateToLatest(target.db, coreMigrations)
  run = importer(env, source, target)
})
afterEach(async () => {
  await source?.cleanup()
  await target?.cleanup()
})

async function seed(
  uuidTable: BsSchemaOptions['uuidTable'],
  players: [pid: number, name: string][],
  mappings: Record<string, unknown>[],
  options: Record<string, string> = {},
): Promise<void> {
  await createBsSchema(source.db, { uuidTable })
  await insertRows(source.db, 'users', [
    {
      uid: 1,
      email: 'owner@example.test',
      score: 0,
      password: '$2y$10$lkVsMF1jleJ9XJczznXCfOnFkh98MgJbIf6.Z7hDX/LfNN.mW5Qka',
      ip: '',
      last_sign_at: '2020-01-01 00:00:00',
      register_at: '2020-01-01 00:00:00',
    },
  ])
  await insertRows(
    source.db,
    'players',
    players.map(([pid, name]) => ({ pid, uid: 1, name, last_modified: '2020-01-01 00:00:00' })),
  )
  await insertRows(source.db, 'uuid', mappings)
  await insertRows(
    source.db,
    'options',
    Object.entries(options).map(([option_name, option_value]) => ({ option_name, option_value })),
  )
}

async function uuids(): Promise<Record<number, string>> {
  const rows = await target.db.selectFrom('players').select(['id', 'uuid']).orderBy('id').execute()
  return Object.fromEntries(rows.map((row) => [row.id, row.uuid]))
}

const A = '0123456789abcdef0123456789abcdef'
const B = 'fedcba9876543210fedcba9876543210'

test('yggdrasil-api：按名字关联，比较规则由旧库决定；带连字符、大写的旧格式统一成小写', async () => {
  await seed(
    'yggdrasil-api',
    [
      [1, 'Steve'],
      [2, 'Renamed'],
      [3, 'Legacy'],
    ],
    [
      { name: 'Steve', uuid: A },
      { name: 'renamed', uuid: B },
      { name: 'Legacy', uuid: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE' },
      { name: 'Gone', uuid: '22222222222222222222222222222222' },
    ],
  )
  const result = await run()
  expect(result.status).toBe('succeeded')
  const mysql = source.config.dialect === 'mysql'
  // 有意按方言区分：MySQL / MariaDB 的 utf8mb4_unicode_ci 忽略大小写，"renamed" 关联得上 "Renamed"，
  // 与 yggdrasil-api 在这个站点上运行时一样；PostgreSQL、SQLite 区分大小写，BS 在那里也查不到，还没分配过
  expect(dialectOf(source.db) === 'mysql').toBe(mysql)
  expect(await uuids()).toEqual({
    1: A,
    2: mysql ? B : offlineUuid('Renamed'),
    3: 'aaaaaaaabbbb4ccc8dddeeeeeeeeeeee',
  })
  expect(result.report.uuid.counts).toEqual({
    pid: 0,
    name: mysql ? 3 : 2,
    override: 0,
    offline: mysql ? 0 : 1,
    random: 0,
  })
  expect(result.report.uuid.nameMismatches.items).toEqual(
    mysql ? [{ pid: 2, name: 'Renamed', mappingName: 'renamed', uuid: B }] : [],
  )
  // 没有对应角色的映射行：Gone；区分大小写的数据库上还有 renamed
  expect(result.report.uuid.orphanMappings).toBe(mysql ? 1 : 2)
  expect(result.report.verification.mismatches.total).toBe(0)
})

test('同一个名字有几行、UUID 各不相同：停止并列出每个候选值，指定之后才导入', async () => {
  await seed(
    'yggdrasil-api',
    [
      [1, 'Steve'],
      [2, 'Alex'],
    ],
    [
      { name: 'Steve', uuid: A },
      { name: 'Steve', uuid: B },
      { name: 'Alex', uuid: 'not-a-uuid' },
    ],
  )
  const blocked = await run()
  expect(blocked.status).toBe('blocked')
  expect(blocked.report.blocking.items).toEqual([
    {
      code: 'uuid_ambiguous',
      pid: 1,
      name: 'Steve',
      candidates: [
        { source: 'name', rowId: 1, name: 'Steve', value: A },
        { source: 'name', rowId: 2, name: 'Steve', value: B },
      ],
    },
    {
      code: 'uuid_invalid',
      pid: 2,
      name: 'Alex',
      candidate: { source: 'name', rowId: 3, name: 'Alex', value: 'not-a-uuid' },
    },
  ])
  expect(await uuids()).toEqual({})

  const fixed = await run({ uuidOverrides: { '1': B.toUpperCase(), '2': '33333333-3333-4333-8333-333333333333' } })
  expect(fixed.status).toBe('succeeded')
  expect(await uuids()).toEqual({ 1: B, 2: '33333333333343338333333333333333' })
  expect(fixed.report.uuid.counts.override).toBe(2)
  expect(fixed.report.uuid.generated.items.map((item) => [item.pid, item.source])).toEqual([
    [1, 'override'],
    [2, 'override'],
  ])
})

test('yggdrasil-connect：按 pid 和按名字都查；两类候选值不同时停止，相同时按 pid 记来源', async () => {
  // yggc:fix-uuid-table 之后又换回 yggdrasil-api：新插入的行只有名字、没有 pid
  await seed(
    'yggdrasil-connect',
    [
      [1, 'Steve'],
      [2, 'Alex'],
      [3, 'NameOnly'],
      [4, 'CaseRow'],
    ],
    [
      { pid: 1, name: 'Steve', uuid: A },
      { pid: 2, name: 'OldAlex', uuid: B },
      { pid: null, name: 'Alex', uuid: '44444444444444444444444444444444' },
      { pid: null, name: 'NameOnly', uuid: '55555555555555555555555555555555' },
      // 只差大小写：MySQL 上按名字也关联得上同一行，报告里只列一次
      { pid: 4, name: 'caserow', uuid: '66666666666666666666666666666666' },
    ],
  )
  const blocked = await run()
  expect(blocked.report.blocking.items).toEqual([
    {
      code: 'uuid_ambiguous',
      pid: 2,
      name: 'Alex',
      candidates: [
        { source: 'pid', rowId: 2, name: 'OldAlex', value: B },
        { source: 'name', rowId: 3, name: 'Alex', value: '44444444444444444444444444444444' },
      ],
    },
  ])
  const fixed = await run({ uuidOverrides: { '2': B } })
  expect(fixed.status).toBe('succeeded')
  expect(await uuids()).toEqual({
    1: A,
    2: B,
    3: '55555555555555555555555555555555',
    4: '66666666666666666666666666666666',
  })
  expect(fixed.report.uuid.counts).toEqual({ pid: 2, name: 1, override: 1, offline: 0, random: 0 })
  expect(fixed.report.uuid.nameMismatches.items).toEqual([
    { pid: 2, name: 'Alex', mappingName: 'OldAlex', uuid: B },
    { pid: 4, name: 'CaseRow', mappingName: 'caserow', uuid: '66666666666666666666666666666666' },
  ])
})

test('两个角色得到同一个 UUID：停止；指定其中一个之后导入', async () => {
  await seed(
    'yggdrasil-api',
    [
      [1, 'Steve'],
      [2, 'Alex'],
    ],
    [
      { name: 'Steve', uuid: A },
      { name: 'Alex', uuid: A.toUpperCase() },
    ],
  )
  const blocked = await run()
  expect(blocked.report.blocking.items).toEqual([{ code: 'duplicate_uuid', uuid: A, pids: [1, 2] }])
  // 指定的值同样要过"两个角色同一个 UUID"的检查
  const stillBlocked = await run({ uuidOverrides: { '2': A } })
  expect(stillBlocked.report.blocking.items).toEqual([{ code: 'duplicate_uuid', uuid: A, pids: [1, 2] }])
  expect((await run({ uuidOverrides: { '2': B } })).status).toBe('succeeded')
  expect(await uuids()).toEqual({ 1: A, 2: B })
})

test('指定文件里的值不合法、pid 不存在：停止', async () => {
  await seed('yggdrasil-api', [[1, 'Steve']], [])
  const result = await run({ uuidOverrides: { '1': 'xyz', '9': A, abc: A } })
  expect(result.report.blocking.items).toEqual([
    { code: 'uuid_override_invalid', pid: '1', value: 'xyz' },
    { code: 'uuid_override_invalid', pid: 'abc', value: A },
    { code: 'uuid_override_unknown_player', pid: '9' },
  ])
})

test('没有映射的角色：v3 按离线算法生成，与 BS 将来会分配的相同；v4 随机生成', async () => {
  await seed('yggdrasil-api', [[1, 'Steve']], [], { ygg_uuid_algorithm: 'v3' })
  expect((await run()).report.uuid.counts.offline).toBe(1)
  expect(await uuids()).toEqual({ 1: offlineUuid('Steve') })

  await source.db
    .updateTable('options')
    .set({ option_value: 'v4' })
    .where('option_name', '=', 'ygg_uuid_algorithm')
    .execute()
  const random = await run({ replace: true })
  expect(random.report.uuid.counts.random).toBe(1)
  const uuid = (await uuids())[1]!
  expect(uuid).toMatch(/^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/)
  expect(uuid).not.toBe(offlineUuid('Steve'))
  // 以后新角色的 UUID 算法跟着旧站
  const setting = await target.db
    .selectFrom('settings')
    .select('value')
    .where('key', '=', 'player.uuidAlgorithm')
    .executeTakeFirst()
  expect(setting).toEqual({ value: '"random"' })
})

test('离线算法算出的 UUID 已经被映射表里的另一个角色占用：生成的那个改用随机 UUID，与先后顺序无关', async () => {
  // Foo 改名为 Bar 之后保留着 Foo 的离线 UUID；后来有人新建了叫 Foo 的角色，还没被 Yggdrasil 查询过
  const taken = offlineUuid('Foo')
  for (const order of [
    [
      [1, 'Foo'],
      [2, 'Bar'],
    ],
    [
      [1, 'Bar'],
      [2, 'Foo'],
    ],
  ] as [number, string][][]) {
    await source.cleanup()
    source = await createTestDatabase<SourceDatabase>()
    run = importer(env, source, target)
    await seed('yggdrasil-api', order, [{ name: 'Bar', uuid: taken }])
    const result = await run({ replace: true })
    expect(result.status).toBe('succeeded')
    const byName = Object.fromEntries(
      (await target.db.selectFrom('players').select(['name', 'uuid']).execute()).map((row) => [row.name, row.uuid]),
    )
    expect(byName.Bar).toBe(taken)
    expect(byName.Foo).toMatch(/^[0-9a-f]{32}$/)
    expect(byName.Foo).not.toBe(taken)
    expect(result.report.uuid.counts).toEqual({ pid: 0, name: 1, override: 0, offline: 0, random: 1 })
    expect(result.report.uuid.generated.items).toEqual([
      { pid: order[0]![1] === 'Foo' ? 1 : 2, name: 'Foo', uuid: byName.Foo, source: 'random' },
    ])
    expect(result.report.verification.mismatches.total).toBe(0)
  }
})

test('连字符只接受标准写法，其余的格式不合法', async () => {
  await seed(
    'yggdrasil-api',
    [
      [1, 'Steve'],
      [2, 'Alex'],
    ],
    [
      { name: 'Steve', uuid: '----aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa----' },
      { name: 'Alex', uuid: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE' },
    ],
  )
  const result = await run()
  expect(result.report.blocking.items).toEqual([
    {
      code: 'uuid_invalid',
      pid: 1,
      name: 'Steve',
      candidate: { source: 'name', rowId: 1, name: 'Steve', value: '----aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa----' },
    },
  ])
  expect((await run({ uuidOverrides: { '1': 'aaaa-aaaa' } })).report.blocking.items).toContainEqual({
    code: 'uuid_override_invalid',
    pid: '1',
    value: 'aaaa-aaaa',
  })
})
