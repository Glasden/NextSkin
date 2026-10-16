/**
 * node:sqlite → Kysely `SqliteDatabase` 接口的薄适配层（Kysely 自带的 SqliteDialect 按 better-sqlite3 的接口设计）。
 *
 * 和 Better Auth 导出的 NodeSqliteDialect 相比，这里处理了三件事：
 * 1. 参数前面固定垫一个空对象 `{}`。node:sqlite 会把"第一个参数是对象"解释成命名参数表：
 *    第一个参数是 Date 时，它被当成空的命名参数表吞掉，后面的参数整体左移一位，写进错误的列，而且不报错。
 * 2. 参数类型在进入 SQLite 前统一检查：Date 和 undefined 直接报错（undefined 在 Node 24 报错、Node 26 绑定为 NULL，行为不一致），
 *    boolean 转成 0/1。
 * 3. 预编译语句做 LRU 缓存，避免每次查询都重新 prepare。
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { SqliteDatabase, SqliteStatement } from 'kysely'

const NO_NAMED = Object.freeze({}) as Record<string, never>

export class UnsupportedParameter extends TypeError {}

export function normalizeParams(params: ReadonlyArray<unknown>): unknown[] {
  const out = new Array(params.length)
  for (let i = 0; i < params.length; i++) {
    const v = params[i]
    switch (typeof v) {
      case 'string':
      case 'number':
      case 'bigint':
        out[i] = v
        break
      case 'boolean':
        out[i] = v ? 1 : 0
        break
      case 'object':
        if (v === null || v instanceof Uint8Array) {
          out[i] = v
          break
        }
        throw new UnsupportedParameter(
          v instanceof Date ? `参数 ${i + 1} 是 Date：日期请先转成 ISO 字符串` : `参数 ${i + 1} 是对象，SQLite 只接受字符串、数字、bigint、Uint8Array 和 null`,
        )
      default:
        throw new UnsupportedParameter(`参数 ${i + 1} 的类型是 ${typeof v}，不能绑定`)
    }
  }
  return out
}

interface Cached {
  stmt: StatementSync
  reader: boolean
}

export function wrapNodeSqlite(db: DatabaseSync, cacheSize = 256): SqliteDatabase {
  const cache = new Map<string, Cached>()
  const get = (sql: string): Cached => {
    let c = cache.get(sql)
    if (c) {
      // Map 按插入顺序迭代：删掉再插入，等于移到最新
      cache.delete(sql)
      cache.set(sql, c)
      return c
    }
    const stmt = db.prepare(sql)
    c = { stmt, reader: stmt.columns().length > 0 }
    cache.set(sql, c)
    if (cache.size > cacheSize) cache.delete(cache.keys().next().value!)
    return c
  }
  return {
    close: () => db.close(),
    prepare(sql: string): SqliteStatement {
      const { stmt, reader } = get(sql)
      return {
        reader,
        all: (p) => stmt.all(NO_NAMED, ...(normalizeParams(p) as any[])),
        run: (p) => stmt.run(NO_NAMED, ...(normalizeParams(p) as any[])),
        iterate: (p) => stmt.iterate(NO_NAMED, ...(normalizeParams(p) as any[])) as IterableIterator<unknown>,
      }
    },
  }
}

/** 核心连接的 PRAGMA。读连接只设前三项之外的部分也可以，但统一设置更省心。 */
export const CORE_PRAGMAS = [
  'pragma journal_mode = wal',
  'pragma synchronous = normal',
  'pragma foreign_keys = on',
  'pragma temp_store = memory',
  'pragma cache_size = -16000',
]
