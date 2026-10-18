import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite'
import type { SqliteDatabase } from 'kysely'

const NO_NAMED_PARAMETERS = Object.freeze({})

export class UnsupportedParameterError extends TypeError {}

export function normalizeParams(parameters: readonly unknown[]): SQLInputValue[] {
  return parameters.map((value, index) => {
    if (value instanceof Date) {
      throw new UnsupportedParameterError(`参数 ${index + 1} 是 Date；请先将日期转成字符串再绑定`)
    }
    if (typeof value === 'boolean') return value ? 1 : 0
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      value instanceof Uint8Array
    )
      return value
    throw new UnsupportedParameterError(
      `参数 ${index + 1} 的类型为 ${typeof value}，无法绑定；请传入 string、number、bigint、Uint8Array 或 null，日期请先转成字符串`,
    )
  })
}

/** node:sqlite 会把首个对象参数当成命名参数表，二进制数据也不例外。 */
export function wrapNodeSqlite(db: DatabaseSync, cacheSize = 256): SqliteDatabase {
  if (!Number.isSafeInteger(cacheSize) || cacheSize < 0)
    throw new RangeError('语句缓存大小无效；请将 cacheSize 设为非负整数')
  const cache = new Map<string, { statement: StatementSync; reader: boolean }>()
  return {
    close() {
      cache.clear()
      db.close()
    },
    prepare(sql) {
      let cached = cache.get(sql)
      if (cached) cache.delete(sql)
      else {
        const statement = db.prepare(sql)
        const reader = statement.columns().length > 0
        // 写语句的 lastInsertRowid 按 bigint 读：主键超过 2^53 时（导入旧站的 bigint id），Node 26 读成 number 会抛错
        if (!reader) statement.setReadBigInts(true)
        cached = { statement, reader }
      }
      cache.set(sql, cached)
      if (cache.size > cacheSize) {
        const oldest = cache.keys().next()
        if (!oldest.done) cache.delete(oldest.value)
      }
      const { statement, reader } = cached
      return {
        reader,
        all: (parameters) => statement.all(NO_NAMED_PARAMETERS, ...normalizeParams(parameters)),
        run: (parameters) => statement.run(NO_NAMED_PARAMETERS, ...normalizeParams(parameters)),
        iterate: (parameters) => statement.iterate(NO_NAMED_PARAMETERS, ...normalizeParams(parameters)),
      }
    },
  }
}
