import { expect, test } from 'vitest'
import { createLogger, createMemoryLogger } from './logger.ts'
import type { LogLevel } from './record.ts'

test('一条记录一行 JSON：UTC 的 ISO 时间、级别的名字、来源、消息，没有 pid 和 hostname', () => {
  const lines: string[] = []
  createLogger('core', { level: 'info', write: (line) => lines.push(line) }).info('ready', { port: 3000 })
  expect(lines).toHaveLength(1)
  expect(lines[0]).not.toContain('\n')
  const { time, ...record } = JSON.parse(lines[0]!) as Record<string, unknown>
  expect(record).toEqual({ level: 'info', source: 'core', port: 3000, msg: 'ready' })
  expect(time).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
})

test('低于出口级别的不记；级别在运行时改了，已经取到的子 logger 也跟着变', () => {
  const lines: string[] = []
  const target = { level: 'warn' as LogLevel, write: (line: string) => void lines.push(line) }
  const child = createLogger('core', target).child({ area: 'jobs' })
  child.info('skipped')
  child.warn('kept')
  target.level = 'debug'
  child.debug('now kept')
  expect(lines.map((line) => (JSON.parse(line) as { msg: string }).msg)).toEqual(['kept', 'now kept'])
})

test('子 logger 带上固定字段；换来源时不会出现两个 source，已有的字段照样带着', () => {
  const { logger, records } = createMemoryLogger()
  const plugins = logger.child({ area: 'plugins' })
  plugins.info('activated', { plugin: 'hello' })
  plugins.child({ source: 'plugin', plugin: 'hello' }).warn('来自插件', { fields: { uid: 3 } })
  logger.child({ source: 'plugin-host', generation: 2 }).warn('stderr 的一行')
  expect(records).toMatchObject([
    { source: 'core', area: 'plugins', plugin: 'hello', msg: 'activated' },
    { source: 'plugin', area: 'plugins', plugin: 'hello', fields: { uid: 3 }, msg: '来自插件' },
    { source: 'plugin-host', generation: 2, msg: 'stderr 的一行' },
  ])
})

test('按字段名兜底：顶层和下一层的密码、令牌、Cookie 一类换成 [redacted]', () => {
  const { logger, records } = createMemoryLogger()
  logger.warn('login_failed', {
    password: 'hunter2',
    cookie: 'a=b',
    fields: { token: 'abc', clientSecret: 's', name: 'Steve' },
    deep: { nested: { password: '深层不管' } },
  })
  expect(records[0]).toMatchObject({
    password: '[redacted]',
    cookie: '[redacted]',
    fields: { token: '[redacted]', clientSecret: '[redacted]', name: 'Steve' },
    deep: { nested: { password: '深层不管' } },
  })
})

test('测试用的 logger 默认收下 debug', () => {
  const { logger, records } = createMemoryLogger({ level: 'info' })
  logger.debug('skipped')
  expect(records).toEqual([])
  const all = createMemoryLogger()
  all.logger.debug('kept')
  expect(all.records).toMatchObject([{ level: 'debug', msg: 'kept' }])
})

test('子 logger 覆盖已有的字段、换来源时，每个键只写出一个', () => {
  const lines: string[] = []
  const logger = createLogger('core', { level: 'debug', write: (line) => void lines.push(line) })
  logger.child({ area: 'a' }).child({ area: 'b' }).info('x')
  logger.child({ area: 'a', plugin: 'p' }).child({ source: 'plugin', plugin: 'q' }).info('y')
  expect(lines[0]!.match(/"area":/g)).toHaveLength(1)
  expect(JSON.parse(lines[0]!)).toMatchObject({ area: 'b' })
  expect(lines[1]!.match(/"plugin":/g)).toHaveLength(1)
  expect(lines[1]!.match(/"source":/g)).toHaveLength(1)
  expect(JSON.parse(lines[1]!)).toMatchObject({ source: 'plugin', area: 'a', plugin: 'q' })
})
