import { MysqlAdapter, type DatabaseConnection, type Dialect, type Driver } from 'kysely'

// 列名可能由参数推导，不能只凭消息中没有“值”就放行；新增 errno 前须补两库实测。
const MYSQL_IDENTIFIER_ONLY_ERRNOS = new Set([
  1044, 1045, 1046, 1049, 1050, 1051, 1061, 1091, 1146, 1205, 1213, 1451, 1452,
])

// mysql2 将 Node 的网络错误直接传出；下列协议码的消息在驱动中是固定说明。
// 不放行通用 PROTOCOL_ERROR，它可能转发服务器提供的任意错误消息。
const MYSQL_READABLE_CLIENT_CODES = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'ECONNABORTED',
  'ENETDOWN',
  'EPIPE',
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_SEQUENCE_TIMEOUT',
  'PROTOCOL_UNEXPECTED_PACKET',
])

/** 驱动错误可能携带 SQL、连接配置和凭据，需脱敏后才能交给调用方记录。 */
export function protectConnectionErrors(dialect: Dialect, secrets: readonly string[]): Dialect {
  const mysql = dialect.createAdapter() instanceof MysqlAdapter
  const original = dialect.createDriver.bind(dialect)
  dialect.createDriver = () => {
    const driver = original()
    const wrapped = new WeakSet<DatabaseConnection>()
    const redact = (error: unknown): Error => {
      let message = error instanceof Error ? error.message : '数据库驱动执行失败；请检查连接配置及服务器状态'
      if (typeof error === 'object' && error !== null) {
        const errno: unknown = Reflect.get(error, 'errno')
        const code: unknown = Reflect.get(error, 'code')
        const sqlState: unknown = Reflect.get(error, 'sqlState')
        if (mysql && typeof errno === 'number' && typeof sqlState === 'string') {
          const name = typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'SERVER_ERROR'
          const omitted = `MySQL 错误 ${errno}（${name}）；原始消息可能含数据值，已省略`
          if (errno === 1062) {
            const key = / for key ['`]([^'`]+)['`]$/.exec(message)?.[1]
            message = key ? `Duplicate entry for key '${key}'` : 'Duplicate entry'
          } else if (errno === 1064) {
            const line = /\bnear '[\s\S]*' at line (\d+)\s*$/i.exec(message)?.[1]
            message = line ? `MySQL SQL 语法错误 near [已脱敏] at line ${line}` : omitted
          } else if (!MYSQL_IDENTIFIER_ONLY_ERRNOS.has(errno)) message = omitted
        } else if (mysql && (typeof code !== 'string' || !MYSQL_READABLE_CLIENT_CODES.has(code))) {
          message = 'MySQL 客户端错误；原始消息可能含数据值，已省略。请检查连接或查询配置'
        }
        // PostgreSQL 22 类异常的双引号内是输入值；贪婪匹配也覆盖值中自带引号的情况。
        if (typeof code === 'string' && code.startsWith('22')) message = message.replace(/"[\s\S]*"/g, '[已脱敏]')
      }
      for (const secret of secrets.filter(Boolean).toSorted((a, b) => b.length - a.length)) {
        message = message.replaceAll(secret, '[已脱敏]')
      }
      const safe = new Error(message)
      // 保留重复键判断需要的错误码，不暴露连接配置或 SQL。
      for (const key of ['code', 'errno', 'sqlState'] as const) {
        if (typeof error === 'object' && error !== null && key in error) {
          const value: unknown = Reflect.get(error, key)
          if (typeof value === 'number' || (typeof value === 'string' && /^[A-Z0-9_]+$/.test(value))) {
            Object.assign(safe, { [key]: value })
          }
        }
      }
      return safe
    }
    const guard = async <T>(operation: () => Promise<T>): Promise<T> => {
      try {
        return await operation()
      } catch (error) {
        throw redact(error)
      }
    }
    const protectedDriver: Driver = {
      init: (options) => guard(() => driver.init(options)),
      acquireConnection: (options) =>
        guard(async () => {
          const connection = await driver.acquireConnection(options)
          if (!wrapped.has(connection)) {
            const execute = connection.executeQuery.bind(connection)
            const stream = connection.streamQuery.bind(connection)
            connection.executeQuery = (query, options) => guard(() => execute(query, options))
            connection.streamQuery = async function* (query, size, options) {
              try {
                yield* stream(query, size, options)
              } catch (error) {
                throw redact(error)
              }
            }
            wrapped.add(connection)
          }
          return connection
        }),
      beginTransaction: (connection, settings) => guard(() => driver.beginTransaction(connection, settings)),
      commitTransaction: (connection) => guard(() => driver.commitTransaction(connection)),
      rollbackTransaction: (connection) => guard(() => driver.rollbackTransaction(connection)),
      releaseConnection: (connection, options) => guard(() => driver.releaseConnection(connection, options)),
      destroy: (options) => guard(() => driver.destroy(options)),
    }
    if (driver.savepoint) protectedDriver.savepoint = (...args) => guard(() => driver.savepoint!(...args))
    if (driver.rollbackToSavepoint)
      protectedDriver.rollbackToSavepoint = (...args) => guard(() => driver.rollbackToSavepoint!(...args))
    if (driver.releaseSavepoint)
      protectedDriver.releaseSavepoint = (...args) => guard(() => driver.releaseSavepoint!(...args))
    return protectedDriver
  }
  return dialect
}
