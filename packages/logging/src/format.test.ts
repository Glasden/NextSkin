import { expect, test } from 'vitest'
import { formatLocalTime, formatLogText } from './format.ts'
import { parseLogRecord, type LogRecord } from './record.ts'

const time = '2026-10-24T12:00:03.007Z'
const local = formatLocalTime(new Date(time))

function record(fields: Partial<LogRecord> & Record<string, unknown>): LogRecord {
  return { time, level: 'info', source: 'core', msg: '', ...fields }
}

test('本机时区的时间，精确到毫秒', () => {
  const date = new Date(time)
  expect(local).toBe(
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ` +
      `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:03.007`,
  )
  expect(formatLocalTime(new Date('不是时间'))).toBe('????-??-?? ??:??:??.???')
})

test('时间、级别、来源和模块、消息、字段', () => {
  expect(
    formatLogText(record({ level: 'warn', area: 'jobs', msg: 'failed', job: 'core:mail', attempt: 2, note: 'a b' })),
  ).toBe(`${local} WARN  core/jobs failed job=core:mail attempt=2 note="a b"`)
  expect(formatLogText(record({ msg: 'activated', area: 'plugins', plugin: 'hello', ok: true, extra: { a: 1 } }))).toBe(
    `${local} INFO  core/plugins activated plugin=hello ok=true extra={"a":1}`,
  )
})

test('插件写的记录：来源一栏是 plugin/<id>，fields 展开一层；截断后成了字符串的 fields 照原样显示', () => {
  expect(formatLogText(record({ source: 'plugin', plugin: 'hello', msg: '注册', fields: { uid: 3 } }))).toBe(
    `${local} INFO  plugin/hello 注册 uid=3`,
  )
  expect(formatLogText(record({ source: 'plugin', plugin: 'hello', msg: 'x', fields: '{"a":"截' }))).toBe(
    `${local} INFO  plugin/hello x fields="{\\"a\\":\\"截"`,
  )
})

test('控制字符转义：换行和终端转义序列伪造不出另一行', () => {
  const text = formatLogText(
    record({
      source: 'plugin',
      plugin: 'evil',
      msg: 'a\n2026-10-24 ERROR core/auth x\u001b[2J',
      fields: { 'k\n': '\u009b1m' },
    }),
  )
  for (const char of ['\n', '\r', '\u001b', '\u009b']) expect(text).not.toContain(char)
  expect(text).toContain('a\\n2026-10-24 ERROR core/auth x\\u001b[2J')
  expect(text).toContain('k\\n=\\u009b1m')
})

test('读文件的一侧：不是这个格式的行当作原始文本', () => {
  expect(parseLogRecord('{"time":"t","level":"info","source":"core","msg":"m","x":1}')).toEqual({
    time: 't',
    level: 'info',
    source: 'core',
    msg: 'm',
    x: 1,
  })
  expect(parseLogRecord('Error: boom')).toBeNull()
  expect(parseLogRecord('{not json')).toBeNull()
  expect(parseLogRecord('{"time":"t","level":"verbose","source":"core","msg":"m"}')).toBeNull()
  expect(parseLogRecord('[1,2]')).toBeNull()
})
