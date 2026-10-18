import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql, type Kysely } from 'kysely'
import { createDatabase } from './database.ts'

export type TestDialect = 'sqlite' | 'mysql' | 'mariadb' | 'postgres'

export function testDialect(): TestDialect {
  const dialect = process.env.NEXTSKIN_TEST_DB ?? 'sqlite'
  if (dialect === 'sqlite' || dialect === 'mysql' || dialect === 'mariadb' || dialect === 'postgres') return dialect
  throw new Error('测试方言无效；请将 NEXTSKIN_TEST_DB 设为 sqlite、mysql、mariadb 或 postgres')
}

/** SQLite 使用文件，没有服务器管理员连接地址。 */
export function testDatabaseAdminUrl(): string | undefined {
  const dialect = testDialect()
  if (dialect === 'sqlite') return undefined
  const defaults = {
    mysql: 'mysql://root:nextskin-test@127.0.0.1:33306/mysql',
    mariadb: 'mysql://root:nextskin-test@127.0.0.1:33307/mysql',
    postgres: 'postgres://postgres:nextskin-test@127.0.0.1:35432/postgres',
  }
  const variable = `NEXTSKIN_TEST_${dialect.toUpperCase()}_URL`
  return process.env[variable] ?? defaults[dialect]
}

/**
 * 删除测试用的临时目录。Windows 上刚删掉的文件可能还处在“删除待定”状态（杀毒软件、索引服务还拿着句柄），
 * 紧接着删目录会报 ENOTEMPTY：SQLite 的连接已经关了、目录里也只剩数据库文件，200 次里仍有几次。
 * Node 的 rm 遇到 ENOTEMPTY、EBUSY、EPERM 时按 retryDelay 线性退避重试
 */
export function removeTestDirectory(directory: string): Promise<void> {
  return rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}

export interface TestDatabase<DB> {
  db: Kysely<DB>
  cleanup(): Promise<void>
}

/** 每个测试文件使用独立数据库；服务器连接需有创建和删除数据库的权限。 */
export async function createTestDatabase<DB>(): Promise<TestDatabase<DB>> {
  const dialect = testDialect()
  if (dialect === 'sqlite') {
    const directory = await mkdtemp(join(tmpdir(), 'nextskin-db-'))
    const db = createDatabase<DB>({ dialect, file: join(directory, 'test.sqlite') })
    return {
      db,
      async cleanup() {
        try {
          await db.destroy()
        } finally {
          await removeTestDirectory(directory)
        }
      },
    }
  }
  const variable = `NEXTSKIN_TEST_${dialect.toUpperCase()}_URL`
  const address = testDatabaseAdminUrl()!
  let target: URL
  try {
    target = new URL(address)
  } catch {
    throw new Error(`${variable} 的连接地址无效；请检查 URL 格式`)
  }
  const serverDialect = dialect === 'mariadb' ? 'mysql' : dialect
  const admin = createDatabase<Record<string, never>>({ dialect: serverDialect, url: address, poolSize: 1 })
  const name = `nextskin_test_${randomUUID().replaceAll('-', '')}`
  target.pathname = `/${name}`
  let db: Kysely<DB> | undefined
  let created = false
  try {
    // 数据库名不能绑定为参数，必须作为标识符转义。
    await sql`create database ${sql.id(name)}`.execute(admin)
    created = true
    db = createDatabase<DB>({ dialect: serverDialect, url: target.toString() })
    const database = db
    return {
      db: database,
      async cleanup() {
        try {
          await database.destroy()
        } finally {
          try {
            await sql`drop database ${sql.id(name)}`.execute(admin)
          } finally {
            await admin.destroy()
          }
        }
      },
    }
  } catch (error) {
    try {
      await db?.destroy()
      if (created) await sql`drop database ${sql.id(name)}`.execute(admin)
    } finally {
      await admin.destroy()
    }
    throw new Error(`创建独立的 ${dialect} 测试数据库失败；请检查 ${variable}、服务器状态及建库权限`, { cause: error })
  }
}
