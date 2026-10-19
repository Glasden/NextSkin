import { DatabaseSync } from 'node:sqlite'
import { sql } from 'kysely'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../testing.ts'
import { createPluginSqliteReader } from './plugin-reader.ts'

let database: TestDatabase<Record<string, never>>
let reader: ReturnType<typeof createPluginSqliteReader>
let file: string
const request = (query: string, timeoutMs = 2000, pluginId = 'sample') => ({
  pluginId,
  sql: query,
  parameters: [],
  deadline: Date.now() + timeoutMs,
})
/**
 * 不带期限函数、只能跑完的原生查询：本机约 0.6 秒，远长于测试给的期限；负载高的 2 核机器上会慢十倍，
 * 所以等它退出的地方都留足时间。不用四张表的全量连接：那要 2.7 秒，被放弃之后还会在后台占着 CPU
 */
const slow =
  'select sum(a.n+b.n+c.n+d.n) from p_sample__numbers a join p_sample__numbers b on 1=1 join p_sample__numbers c on 1=1 join p_sample__numbers d on 1=1 where a.n<=50 and b.n<=50 and c.n<=50 and d.n<=50'
const count = 'select count(*) as n from p_sample__numbers'

beforeAll(async () => {
  database = await createTestDatabase<Record<string, never>>()
  if (database.config.dialect !== 'sqlite') throw new Error('此测试只使用 SQLite')
  await sql`create table users(secret text)`.execute(database.db)
  await sql`insert into users values ('private')`.execute(database.db)
  await sql`create table p_sample__numbers(n integer)`.execute(database.db)
  await sql`with recursive s(n) as (values(1) union all select n+1 from s where n<80) insert into p_sample__numbers select n from s`.execute(
    database.db,
  )
  await sql`create table p_other__numbers(n integer)`.execute(database.db)
  file = database.config.file
  reader = createPluginSqliteReader(file)
})
afterAll(async () => {
  await reader?.close()
  await database?.cleanup()
})

test('期限函数实验：常量参数在最外层循环，四表 JOIN 可以中止但不是逐行检查', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(
      'create table t(n integer); with recursive s(n) as (values(1) union all select n+1 from s where n<80) insert into t select n from s',
    )
    let calls = 0
    db.function('probe', (deadline) => {
      calls++
      if (Date.now() >= Number(deadline)) throw new Error('deadline')
      return 1
    })
    const query = 'select sum(a.n+b.n+c.n+d.n) from t a join t b on 1=1 join t c on 1=1 join t d on 1=1 where probe(?)'
    const plan = db.prepare(`explain ${query}`).all(Date.now() + 1000)
    const functionIndex = plan.findIndex((op) => op.opcode === 'Function')
    const loops = plan.map((op, i) => (op.opcode === 'Rewind' ? i : -1)).filter((i) => i >= 0)
    expect(functionIndex).toBeGreaterThan(loops[0]!)
    expect(functionIndex).toBeLessThan(loops[1]!)
    const start = performance.now()
    expect(() => db.prepare(query).all(Date.now() + 30)).toThrow('deadline')
    expect(performance.now() - start).toBeLessThan(1500)
    expect(calls).toBeLessThanOrEqual(80)
  } finally {
    db.close()
  }
})

test('写连接、读连接和事务连接都注册期限函数，期限参数互不干扰', async () => {
  await expect(sql`select nextskin_deadline(${Date.now() - 1})`.execute(database.db)).rejects.toThrow('deadline')
  expect(
    (await sql<{ ok: number }>`select nextskin_deadline(${Date.now() + 1000}) as ok`.execute(database.db)).rows,
  ).toEqual([{ ok: 1 }])
  await database.db.transaction().execute(async (trx) => {
    await expect(
      sql`update p_sample__numbers set n=n where nextskin_deadline(${Date.now() - 1})`.execute(trx),
    ).rejects.toThrow('deadline')
    expect((await sql<{ ok: number }>`select nextskin_deadline(${Date.now() + 1000}) as ok`.execute(trx)).rows).toEqual(
      [{ ok: 1 }],
    )
  })
})

test('绕过重建器的原始 SQL 仍然不能读取核心表、其他插件或写表；不沿用前一次授权', async () => {
  expect((await reader.execute(request(count))).rows).toEqual([{ n: 80 }])
  for (const query of [
    'select * from users',
    'select count(*) from users',
    'select * from p_other__numbers',
    'select * from sqlite_master',
    'delete from p_sample__numbers',
    'pragma table_info(users)',
    'begin',
  ]) {
    await expect(reader.execute(request(query))).rejects.toMatchObject({ code: 'failed' })
  }
  await reader.execute(request('select * from p_other__numbers', 2000, 'other'))
  await expect(reader.execute(request('select * from p_other__numbers'))).rejects.toMatchObject({ code: 'failed' })
  expect((await sql`select * from users`.execute(database.db)).rows).toEqual([{ secret: 'private' }])
})

test('worker 的期限函数中止慢查询后，同一个 worker 可继续服务', async () => {
  const slow =
    'select sum(a.n+b.n+c.n+d.n) from p_sample__numbers a join p_sample__numbers b on 1=1 join p_sample__numbers c on 1=1 join p_sample__numbers d on 1=1 where nextskin_deadline(?)'
  await expect(reader.execute({ ...request(slow), parameters: [Date.now() + 30] })).rejects.toMatchObject({
    code: 'timeout',
  })
  expect((await reader.execute(request(count))).rows).toEqual([{ n: 80 }])
})

test('没有期限函数的原生查询被放弃，事件循环不阻塞，新 worker 能继续服务', async () => {
  let ticked = false
  const timer = setTimeout(() => {
    ticked = true
  }, 5)
  const start = performance.now()
  await expect(reader.execute(request(slow, 30))).rejects.toMatchObject({ code: 'timeout' })
  clearTimeout(timer)
  expect(ticked).toBe(true)
  expect(performance.now() - start).toBeLessThan(1000)
  expect((await reader.execute(request(count))).rows).toEqual([{ n: 80 }])
  // 等旧的原生查询退出：不把它留给后面的测试，测试库清理时也不留下仍占用文件的连接
  await expect.poll(() => reader.abandoned, { timeout: 60_000, interval: 100 }).toBe(0)
}, 90_000)

test('最多放弃两个仍未退出的 worker，退出后恢复服务', async () => {
  const own = createPluginSqliteReader(file)
  const counted = () => own.execute(request(count, 10_000))
  try {
    // 先用快查询把 worker 起好再发慢查询：worker 收到请求时已经过了期限就不执行，也就不会被放弃
    for (let attempt = 0; own.abandoned < 2; attempt++) {
      expect(attempt).toBeLessThan(10)
      expect((await counted()).rows).toEqual([{ n: 80 }])
      await expect(own.execute(request(slow, 50))).rejects.toMatchObject({ code: 'timeout' })
    }
    await expect(counted()).rejects.toMatchObject({ code: 'timeout' })
    // 原生查询跑完、worker 退出之后才空出名额
    await expect.poll(() => own.abandoned, { timeout: 60_000, interval: 100 }).toBeLessThan(2)
    expect((await counted()).rows).toEqual([{ n: 80 }])
    await expect.poll(() => own.abandoned, { timeout: 60_000, interval: 100 }).toBe(0)
  } finally {
    await own.close()
  }
}, 150_000)
