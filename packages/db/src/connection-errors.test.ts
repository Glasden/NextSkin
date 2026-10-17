import { inspect } from 'node:util'
import { MysqlDialect, PostgresDialect } from 'kysely'
import { expect, test } from 'vitest'
import { protectConnectionErrors } from './connection-errors.ts'

test('驱动错误保留重复键错误码，移除连接凭据和敏感元数据', async () => {
  const address = 'mysql://root:p%40ssword@localhost/test'
  const native = Object.assign(new Error(`连接被拒绝：${address}，密码 p@ssword p%40ssword`), {
    errno: 1062,
    code: 'ER_DUP_ENTRY',
    sqlState: '23000',
    sql: 'sensitive query',
    config: { password: 'p@ssword' },
    cause: new Error(`连接失败：${address}`),
  })
  const dialect = protectConnectionErrors(
    new MysqlDialect({
      pool: {
        getConnection: () => {
          throw native
        },
        end: (callback) => {
          callback(undefined)
        },
      },
    }),
    [address, 'p@ssword', 'p%40ssword'],
  )
  const driver = dialect.createDriver()
  await driver.init()
  const error: unknown = await driver.acquireConnection().catch((error: unknown) => error)
  expect(error).toMatchObject({ errno: 1062, code: 'ER_DUP_ENTRY', sqlState: '23000' })
  const output = inspect(error, { depth: 10 })
  for (const secret of [address, 'p@ssword', 'p%40ssword', 'sensitive query']) expect(output).not.toContain(secret)
  expect(error).not.toHaveProperty('config')
  expect(error).not.toHaveProperty('cause')
  await driver.destroy()
})

test.each([
  {
    errno: 1062,
    message: "Duplicate entry 'quoted 'secret-value\n tail' for key 'items.name'",
    structure: 'items.name',
  },
  {
    errno: 1366,
    message: "Incorrect integer value: 'quoted 'secret-value\n tail' for column 'n' at row 1",
    structure: 'MySQL 错误 1366',
  },
  {
    errno: 1292,
    message: "Truncated incorrect DOUBLE value: 'quoted 'secret-value\n tail'",
    structure: 'MySQL 错误 1292',
  },
  { errno: 1265, message: "Data truncated for column 'n' at row 1", structure: 'MySQL 错误 1265' },
  { errno: 1064, message: "SQL syntax error near 'selct 'secret-value\n tail'' at line 1", structure: 'at line 1' },
  { code: '22P02', message: 'invalid input syntax for integer: "before"secret-value\n tail"', structure: 'integer' },
])('错误 $errno $code 中自带引号和换行的输入值也会被移除', async ({ errno, code, message, structure }) => {
  const native = Object.assign(new Error(message), { errno, code, sqlState: errno === undefined ? undefined : 'HY000' })
  const dialect =
    errno === undefined && code?.startsWith('22')
      ? new PostgresDialect({
          pool: { options: {}, connect: () => Promise.reject(native), end: () => Promise.resolve() },
        })
      : new MysqlDialect({
          pool: {
            getConnection: () => {
              throw native
            },
            end: (callback) => callback(null),
          },
        })
  const driver = protectConnectionErrors(dialect, []).createDriver()
  await driver.init()
  try {
    const error: unknown = await driver.acquireConnection().catch((error: unknown) => error)
    expect(error).toBeInstanceOf(Error)
    const rendered = inspect(new Error('操作失败', { cause: error }), { depth: 10 })
    expect(rendered).not.toContain('secret-value')
    expect(String(error)).toContain(structure)
    if (errno !== undefined) expect(error).toHaveProperty('errno', errno)
    if (code !== undefined) expect(error).toHaveProperty('code', code)
  } finally {
    await driver.destroy()
  }
})

test.each([
  { code: undefined, message: 'server wants to read secret-client-input file' },
  { code: 'UNKNOWN_CLIENT_ERROR', message: '未知客户端错误携带 secret-client-input' },
])('未知客户端错误 $code 不保留可能含参数值的消息', async ({ code, message }) => {
  const native = Object.assign(new Error(message), { code })
  const driver = protectConnectionErrors(
    new MysqlDialect({
      pool: {
        getConnection: () => {
          throw native
        },
        end: (callback) => callback(null),
      },
    }),
    [],
  ).createDriver()
  await driver.init()
  try {
    const error: unknown = await driver.acquireConnection().catch((error: unknown) => error)
    expect(error).toBeInstanceOf(Error)
    expect(inspect(error, { depth: 10 })).not.toContain('secret-client-input')
    if (code !== undefined) expect(error).toHaveProperty('code', code)
  } finally {
    await driver.destroy()
  }
})

test('连接被拒绝时保留可读的网络错误和错误码', async () => {
  const native = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:33306'), { code: 'ECONNREFUSED', errno: -111 })
  const driver = protectConnectionErrors(
    new MysqlDialect({
      pool: {
        getConnection: () => {
          throw native
        },
        end: (callback) => callback(null),
      },
    }),
    [],
  ).createDriver()
  await driver.init()
  try {
    const error: unknown = await driver.acquireConnection().catch((error: unknown) => error)
    expect(error).toMatchObject({ message: native.message, code: 'ECONNREFUSED', errno: -111 })
  } finally {
    await driver.destroy()
  }
})

test.each([
  { code: 'PROTOCOL_CONNECTION_LOST', message: 'Connection lost: The server closed the connection.' },
  { code: 'PROTOCOL_SEQUENCE_TIMEOUT', message: 'Query inactivity timeout' },
  { code: 'PROTOCOL_UNEXPECTED_PACKET', message: 'Unexpected packet while no commands in the queue' },
])('协议错误 $code 保留驱动的固定说明', async ({ code, message }) => {
  const native = Object.assign(new Error(message), { code })
  const driver = protectConnectionErrors(
    new MysqlDialect({
      pool: {
        getConnection: () => {
          throw native
        },
        end: (callback) => callback(null),
      },
    }),
    [],
  ).createDriver()
  await driver.init()
  try {
    const error: unknown = await driver.acquireConnection().catch((error: unknown) => error)
    expect(error).toMatchObject({ code, message })
  } finally {
    await driver.destroy()
  }
})
