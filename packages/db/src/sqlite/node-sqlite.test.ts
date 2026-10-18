import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { normalizeParams, UnsupportedParameterError, wrapNodeSqlite } from './node-sqlite.ts'

let native: DatabaseSync
beforeEach(() => {
  native = new DatabaseSync(':memory:')
})
afterEach(() => {
  native.close()
})

test('首个参数为 Date 时提示先转字符串，不让后续参数错位', () => {
  const db = wrapNodeSqlite(native)
  expect(() => db.prepare('select ? as a, ? as b').all([new Date(), 'second'])).toThrow(/Date.*日期转成字符串/)
  expect(db.prepare('select ? as a, ? as b').all(['first', 'second'])).toEqual([{ a: 'first', b: 'second' }])
})

test('明确拒绝 undefined 和不支持的对象参数', () => {
  expect(() => wrapNodeSqlite(native).prepare('select ?').all([undefined])).toThrow(/undefined/)
  for (const value of [{}, [], Symbol('x'), () => 1]) {
    expect(() => normalizeParams([value])).toThrow(UnsupportedParameterError)
  }
})

test('布尔值转成整数，支持的标量类型能正确绑定', () => {
  const db = wrapNodeSqlite(native)
  expect(db.prepare('select ? as t, ? as f, ? as n, ? as s, ? as b').all([true, false, null, 'text', 42n])).toEqual([
    { t: 1, f: 0, n: null, s: 'text', b: 42 },
  ])
})

test('首个 Uint8Array 参数能原样往返，不被当作命名参数表', () => {
  const bytes = new Uint8Array([0, 1, 127, 255])
  expect(wrapNodeSqlite(native).prepare('select ? as bytes, ? as next').all([bytes, 'next'])).toEqual([
    { bytes, next: 'next' },
  ])
})

test('LRU 命中后刷新顺序并淘汰最久未用的语句', () => {
  const prepare = vi.spyOn(native, 'prepare')
  const db = wrapNodeSqlite(native, 2)
  db.prepare('select 1')
  db.prepare('select 2')
  db.prepare('select 1')
  db.prepare('select 3')
  db.prepare('select 1')
  expect(prepare).toHaveBeenCalledTimes(3)
  db.prepare('select 2')
  expect(prepare).toHaveBeenCalledTimes(4)
})

test('RETURNING 被识别为返回行，缓存大小为零时不复用语句', () => {
  const prepare = vi.spyOn(native, 'prepare')
  const db = wrapNodeSqlite(native, 0)
  db.prepare('create table t (n integer)').run([])
  const statement = db.prepare('insert into t values (?) returning n')
  expect(statement.reader).toBe(true)
  expect(statement.all([12])).toEqual([{ n: 12 }])
  db.prepare('select 1')
  db.prepare('select 1')
  expect(prepare).toHaveBeenCalledTimes(4)
  expect(() => wrapNodeSqlite(native, -1)).toThrow(RangeError)
})

test('写语句的 lastInsertRowid 超过 2^53 时原样返回 bigint，不抛错也不丢精度', () => {
  const db = wrapNodeSqlite(native)
  db.prepare('create table big (id integer primary key, name text)').run([])
  const result = db.prepare('insert into big (id, name) values (?, ?)').run([9007199254740993n, 'big'])
  expect(BigInt(result.lastInsertRowid)).toBe(9007199254740993n)
  expect(BigInt(result.changes)).toBe(1n)
  // 读语句不受影响：整数仍按 number 读
  expect(db.prepare('select count(*) as count from big').all([])).toEqual([{ count: 1 }])
})
