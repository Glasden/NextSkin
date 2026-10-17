import { randomUUID } from 'node:crypto'
import { createConnection } from 'mysql2/promise'
import { MysqlDialect } from 'kysely'
import { expect, test } from 'vitest'
import { protectConnectionErrors } from './connection-errors.ts'
import { testDatabaseAdminUrl, testDialect } from '@nextskin/db/testing'

const verified = [1044, 1045, 1046, 1049, 1050, 1051, 1061, 1091, 1146, 1205, 1213, 1451, 1452]

test.runIf(testDialect() === 'mysql' || testDialect() === 'mariadb')(
  '服务器错误白名单保留无数据值消息并省略未确认的消息',
  async () => {
    // 原生错误格式是 MySQL/MariaDB 专属；探测只创建并清理自己的临时库、临时用户和连接。
    const observations = await probeMysqlErrors()
    expect(observations.map((error) => error.candidate)).toHaveLength(25)
    for (const errno of verified) {
      const native = observations.find((error) => error.candidate === errno)
      expect(native?.errno).toBe(errno)
      expect(native?.message).not.toContain('secret-')
      expect(native?.message).not.toContain('incorrect-test-password')
    }
    for (const native of observations) {
      const error = Object.assign(new Error(native.message), native)
      const driver = protectConnectionErrors(
        new MysqlDialect({
          pool: {
            getConnection: () => {
              throw error
            },
            end: (callback) => callback(null),
          },
        }),
        [],
      ).createDriver()
      await driver.init()
      try {
        const safe: unknown = await driver.acquireConnection().catch((error: unknown) => error)
        expect(safe).toHaveProperty('errno', native.errno)
        expect(safe).toHaveProperty('sqlState', native.sqlState)
        if (verified.includes(native.errno)) expect(safe).toHaveProperty('message', native.message)
        else expect(String(safe)).toContain('原始消息可能含数据值，已省略')
      } finally {
        await driver.destroy()
      }
    }
  },
  10000,
)

interface MysqlErrorObservation {
  candidate: number
  errno: number
  code: string
  sqlState: string
  message: string
}

/** 只在指定测试服务器创建自己的库、用户和连接，逐一实测消息格式。 */
async function probeMysqlErrors(): Promise<MysqlErrorObservation[]> {
  const address = testDatabaseAdminUrl()
  if (!address) throw new Error('白名单探针需要 MySQL 或 MariaDB 管理员连接地址')
  let server: URL
  try {
    server = new URL(address)
  } catch {
    throw new Error('白名单探针的管理员连接地址无效；请检查测试连接环境变量')
  }
  // 1046 要求没有默认数据库，其他连接仍继承管理员地址中的 TLS 等配置。
  server.pathname = ''
  const admin = await createConnection(server.toString())
  const name = `ns_probe_${randomUUID().replaceAll('-', '')}`
  const user = name.slice(0, 30)
  const observations: MysqlErrorObservation[] = []
  let created = false
  let userCreated = false
  const record = (candidate: number, error: unknown) => {
    if (!(error instanceof Error)) throw new Error(`候选错误 ${candidate} 未返回 Error`)
    const errno: unknown = Reflect.get(error, 'errno')
    const code: unknown = Reflect.get(error, 'code')
    const sqlState: unknown = Reflect.get(error, 'sqlState')
    if (typeof errno !== 'number') {
      throw new Error(`候选错误 ${candidate} 未返回完整的服务器错误码`)
    }
    observations.push({
      candidate,
      errno,
      code: typeof code === 'string' ? code : '',
      sqlState: typeof sqlState === 'string' ? sqlState : '',
      message: error.message,
    })
  }
  const trigger = async (candidate: number, operation: () => Promise<unknown>) => {
    try {
      await operation()
    } catch (error) {
      record(candidate, error)
      return
    }
    throw new Error(`候选错误 ${candidate} 未触发预期错误`)
  }
  const query = (text: string) => admin.query(text)
  try {
    await trigger(1046, () => query('select * from no_database_selected'))
    await query(`create database \`${name}\``)
    created = true
    await query(`use \`${name}\``)
    await query("set session sql_mode = 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION'")
    await query(
      "create table probe (id integer primary key, n integer not null, tiny tinyint, label varchar(2), choice enum('one')) engine=InnoDB",
    )
    await query('insert into probe (id,n) values (1,1),(2,2)')
    await query('create index same_index on probe(n)')
    await query('create table parent (id integer primary key, n integer) engine=InnoDB')
    await query(
      'create table child (id integer primary key, parent_id integer, constraint fk_parent foreign key(parent_id) references parent(id)) engine=InnoDB',
    )
    await query('insert into parent values (1,1)')
    await query('insert into child values (1,1)')
    await query('create table checked (n integer, constraint positive_n check(n>0)) engine=InnoDB')
    const cases: [number, string][] = [
      [1048, 'insert into probe(id,n) values (3,null)'],
      [1049, `use \`${name}_missing\``],
      [1050, 'create table probe (id integer)'],
      [1051, 'drop table missing_table'],
      [1054, 'select missing_column from probe'],
      [1060, 'alter table probe add column n integer'],
      [1061, 'create index same_index on probe(n)'],
      [1091, 'alter table probe drop column missing_column'],
      [1146, 'select * from missing_table'],
      [1215, 'alter table probe add constraint invalid_fk foreign key(n) references parent(n)'],
      [1216, 'insert into child values (2,999)'],
      [1217, 'delete from parent where id=1'],
      [1264, 'insert into probe(id,n,tiny) values (3,3,1000)'],
      [1265, "insert into probe(id,n,choice) values (3,3,'secret-enum-input')"],
      [1364, 'insert into probe(id) values (3)'],
      [1406, "insert into probe(id,n,label) values (3,3,'secret-overlong-input')"],
      [1451, 'delete from parent where id=1'],
      [1452, 'insert into child values (2,999)'],
      [3819, 'insert into checked values (-1)'],
      [4025, 'insert into checked values (-1)'],
    ]
    for (const [candidate, text] of cases) await trigger(candidate, () => query(text))
    await query(`create user '${user}'@'%'`)
    userCreated = true
    const restrictedUrl = new URL(server)
    restrictedUrl.username = user
    restrictedUrl.password = ''
    const restricted = await createConnection(restrictedUrl.toString())
    try {
      await trigger(1044, () => restricted.query(`use \`${name}\``))
    } finally {
      await restricted.end()
    }
    await trigger(1045, async () => {
      const deniedUrl = new URL(restrictedUrl)
      deniedUrl.password = 'incorrect-test-password'
      const connection = await createConnection(deniedUrl.toString())
      await connection.end()
    })
    const databaseUrl = new URL(server)
    databaseUrl.pathname = `/${name}`
    const first = await createConnection(databaseUrl.toString())
    const second = await createConnection(databaseUrl.toString())
    try {
      await second.query('set session innodb_lock_wait_timeout=1')
      await first.beginTransaction()
      await second.beginTransaction()
      await first.query('update probe set n=n+1 where id=1')
      await trigger(1205, () => second.query('update probe set n=n+1 where id=1'))
      await first.rollback()
      await second.rollback()
      await first.beginTransaction()
      await second.beginTransaction()
      await first.query('update probe set n=n+1 where id=1')
      await second.query('update probe set n=n+1 where id=2')
      const results = await Promise.allSettled([
        first.query('update probe set n=n+1 where id=2'),
        second.query('update probe set n=n+1 where id=1'),
      ])
      const victim = results.find((result) => result.status === 'rejected')
      if (!victim || victim.status !== 'rejected') throw new Error('未触发测试连接之间的死锁')
      const reason: unknown = victim.reason
      record(1213, reason)
    } finally {
      await Promise.all([first.rollback(), second.rollback()])
      await Promise.all([first.end(), second.end()])
    }
    return observations.sort((a, b) => a.candidate - b.candidate)
  } finally {
    try {
      if (userCreated) await query(`drop user '${user}'@'%'`)
      if (created) await query(`drop database \`${name}\``)
    } finally {
      await admin.end()
    }
  }
}

test.runIf(testDialect() === 'mysql' || testDialect() === 'mariadb')(
  '参数生成的列名、排序位置和递归列标签不会泄露数据值',
  async () => {
    const { createTestDatabase } = await import('@nextskin/db/testing')
    const { sql } = await import('kysely')
    const { inspect } = await import('node:util')
    const database = await createTestDatabase()
    const secret = 'secret-derived-column'
    try {
      const cases = [
        { errno: 1060, secret, query: sql`select * from (select ${secret}, ${secret}) as t` },
        { errno: 1054, secret: '987654321', query: sql`select 1 order by ${987654321}` },
        {
          errno: 1406,
          secret,
          query: sql`with recursive cte as (select ${secret}, 1 as n union all
          select concat(${secret}, 'x'), n+1 from cte where n<2) select * from cte`,
        },
        {
          errno: 1264,
          secret: '9876543210',
          query: sql`with recursive cte as
          (select cast(${'9876543210'} as decimal(10,0)), 1 as n union all
          select 10000000000, n+1 from cte where n<2) select * from cte`,
        },
      ]
      // 每个场景独立断言，避免一个错误码泄漏时掩盖其他场景。
      for (const scenario of cases) {
        const failure: unknown = await scenario.query.execute(database.db).catch((error: unknown) => error)
        expect.soft(failure).toHaveProperty('errno', scenario.errno)
        expect.soft(inspect(failure, { depth: 10 })).not.toContain(scenario.secret)
      }
      await database.db.connection().execute(async (connection) => {
        await sql`create table label_source(n integer not null, choice enum('one') not null)`.execute(connection)
        await sql`insert into label_source values(1, 'one')`.execute(connection)
        await sql`create temporary table inferred_number as select n as ${secret} from label_source`.execute(connection)
        await sql`create temporary table inferred_enum as select choice as ${secret} from label_source`.execute(
          connection,
        )
        const cases = [
          { errno: 1048, query: sql`insert into inferred_number values(null)` },
          { errno: 1364, query: sql`insert into inferred_number () values()` },
          { errno: 1265, query: sql`insert into inferred_enum values('two')` },
        ]
        for (const scenario of cases) {
          const failure: unknown = await scenario.query.execute(connection).catch((error: unknown) => error)
          expect.soft(failure).toHaveProperty('errno', scenario.errno)
          expect.soft(inspect(failure, { depth: 10 })).not.toContain(secret)
        }
      })
    } finally {
      await database.cleanup()
    }
  },
)
