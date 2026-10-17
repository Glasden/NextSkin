import { CompiledQuery, Kysely, MysqlDialect, PostgresDialect } from 'kysely'
import { createPool, type PoolOptions } from 'mysql2'
import { Pool } from 'pg'
import { protectConnectionErrors } from './connection-errors.ts'
import { SqliteWalDialect } from './sqlite/dialect.ts'

export type DatabaseConfig =
  | { dialect: 'sqlite'; file: string; busyTimeoutMs?: number; lockTimeoutMs?: number }
  | { dialect: 'mysql'; url: string; poolSize?: number }
  | { dialect: 'postgres'; url: string; poolSize?: number }

const MYSQL_SQL_MODE =
  'STRICT_TRANS_TABLES,ONLY_FULL_GROUP_BY,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'

export function createDatabase<DB>(config: DatabaseConfig): Kysely<DB> {
  if (config.dialect === 'sqlite') return new Kysely<DB>({ dialect: new SqliteWalDialect(config) })
  if (config.poolSize !== undefined && (!Number.isSafeInteger(config.poolSize) || config.poolSize < 1)) {
    throw new RangeError('连接池大小无效；请将 poolSize 设为正整数')
  }
  // URL 原生解析错误会保留含密码的输入，因此解析失败时不附原始错误。
  let url: URL
  try {
    url = new URL(config.url)
  } catch {
    throw new Error('数据库连接地址无效；请检查 URL 格式及字符转义')
  }
  const password = decodeCredential(url.password)
  const user = decodeCredential(url.username)
  const secrets = [config.url, url.password, password]
  if (config.dialect === 'mysql') {
    if (url.protocol !== 'mysql:') throw new Error('MySQL 连接地址的协议无效；请使用 mysql:// 开头的 URL')
    const options: PoolOptions = {
      host: decodeCredential(url.hostname.replace(/^\[|\]$/g, '')),
      port: url.port ? Number(url.port) : 3306,
      user,
      password,
      database: decodeCredential(url.pathname.slice(1)),
      connectionLimit: config.poolSize ?? 10,
      charset: 'utf8mb4',
      timezone: 'Z',
      multipleStatements: false,
      resetOnRelease: false,
      flags: ['-LOCAL_FILES'],
    }
    for (const [name, value] of url.searchParams) {
      if (name === 'ssl') {
        try {
          const ssl: unknown = JSON.parse(value)
          if (!ssl || typeof ssl !== 'object' || Array.isArray(ssl)) throw new Error()
          options.ssl = ssl
        } catch {
          throw new Error('MySQL 的 ssl 参数无效；请提供 JSON 格式的 TLS 选项对象')
        }
      } else if (name === 'connectTimeout') {
        const timeout = Number(value)
        if (!value.trim() || !Number.isSafeInteger(timeout) || timeout < 0 || timeout > 2147483647) {
          throw new Error('MySQL 的 connectTimeout 参数无效；请提供 0 到 2147483647 之间的整数毫秒数')
        }
        options.connectTimeout = timeout
      } else {
        throw new Error(`MySQL 连接地址不支持参数 ${name}；只允许 ssl 和 connectTimeout`)
      }
    }
    let pool: ReturnType<typeof createPool>
    try {
      pool = createPool(options)
    } catch {
      throw new Error('MySQL 连接配置无效；请检查 URL 中的参数及字符转义')
    }
    return new Kysely<DB>({
      dialect: protectConnectionErrors(
        new MysqlDialect({
          pool,
          // 事件监听器不会等待异步操作；使用此钩子确保会话设置完成后才交出连接。
          onCreateConnection: async (connection) => {
            await connection.executeQuery(
              CompiledQuery.raw(`set session sql_mode = '${MYSQL_SQL_MODE}', time_zone = '+00:00'`),
            )
            await connection.executeQuery(CompiledQuery.raw('set session transaction isolation level read committed'))
          },
        }),
        secrets,
      ),
    })
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    throw new Error('PostgreSQL 连接地址的协议无效；请使用 postgres:// 或 postgresql:// 开头的 URL')
  const pool = new Pool({ connectionString: config.url, max: config.poolSize ?? 10 })
  // pg 会自动丢弃出错的空闲连接；监听 error 避免未捕获异常，待日志模块落地后再记录脱敏错误。
  pool.on('error', () => {})
  return new Kysely<DB>({
    dialect: protectConnectionErrors(
      new PostgresDialect({
        pool,
        onCreateConnection: async (connection) => {
          await connection.executeQuery(CompiledQuery.raw("set time zone 'UTC'"))
        },
      }),
      secrets,
    ),
  })
}

function decodeCredential(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new Error('数据库连接地址的编码无效；请对用户名和密码使用正确的 URL 百分号转义')
  }
}
