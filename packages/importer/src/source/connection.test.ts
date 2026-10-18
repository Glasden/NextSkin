import { resolve } from 'node:path'
import { expect, test } from 'vitest'
import { describeConnection, parseSourceDsn, snapshotSource } from './connection.ts'

test('解析 --from，记录里不含密码，连接地址正确转义', () => {
  const mysql = parseSourceDsn('mysql://bs%40user:p%40ss%2Fw%3Ard@db.local:3307/blessing%20skin', '/')
  expect(mysql).toEqual({
    dialect: 'mysql',
    host: 'db.local',
    port: 3307,
    database: 'blessing skin',
    username: 'bs@user',
    password: 'p@ss/w:rd',
  })
  expect(describeConnection(mysql)).toEqual({
    dialect: 'mysql',
    host: 'db.local',
    port: 3307,
    database: 'blessing skin',
    username: 'bs@user',
  })
  const url = new URL((snapshotSource(mysql) as { url: string }).url)
  expect([
    decodeURIComponent(url.username),
    decodeURIComponent(url.password),
    decodeURIComponent(url.pathname),
  ]).toEqual(['bs@user', 'p@ss/w:rd', '/blessing skin'])
  expect(parseSourceDsn('postgresql://u@[::1]/bs', '/')).toMatchObject({ dialect: 'postgres', host: '::1', port: 5432 })
  expect(parseSourceDsn('sqlite:bs.sqlite', '/srv')).toEqual({ dialect: 'sqlite', file: resolve('/srv', 'bs.sqlite') })
})

test('格式不对时报错，不回显地址', () => {
  for (const dsn of ['mssql://u:hunter2@db/x', 'hunter2', 'mysql://u:hunter2@db/', 'sqlite:'])
    expect(() => parseSourceDsn(dsn, '/')).toThrow(/^(?!.*hunter2)/)
})
