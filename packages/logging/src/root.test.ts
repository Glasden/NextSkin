import { afterEach, expect, test } from 'vitest'
import {
  captureLogs,
  configureRootLogger,
  getLogger,
  logFormatFromEnv,
  logLevelFromEnv,
  rootLogger,
  terminalWriter,
} from './root.ts'

const restores: (() => void)[] = []
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore()
})

test('级别：NEXTSKIN_LOG_LEVEL，没设或认不出时 pnpm dev 是 debug、其余是 info', () => {
  expect(logLevelFromEnv({ NEXTSKIN_LOG_LEVEL: ' WARN ' })).toBe('warn')
  expect(logLevelFromEnv({ NEXTSKIN_LOG_LEVEL: 'verbose', NODE_ENV: 'production' })).toBe('info')
  expect(logLevelFromEnv({ NODE_ENV: 'development' })).toBe('debug')
  expect(logLevelFromEnv({})).toBe('info')
})

test('格式：NEXTSKIN_LOG_FORMAT=json 时写 NDJSON，其余写给人看的一行', () => {
  expect(logFormatFromEnv({ NEXTSKIN_LOG_FORMAT: 'JSON' })).toBe('json')
  expect(logFormatFromEnv({ NEXTSKIN_LOG_FORMAT: 'pretty' })).toBe('text')
  expect(logFormatFromEnv({})).toBe('text')
})

test('写终端：warn 及以上写 stderr，其余写 stdout；认不出的行原样写 stdout', () => {
  const stdout: string[] = []
  const stderr: string[] = []
  const streams = {
    stdout: { write: (text: string) => stdout.push(text) },
    stderr: { write: (text: string) => stderr.push(text) },
  }
  const line = (level: string) =>
    JSON.stringify({ level, time: '2026-10-24T12:00:00.000Z', source: 'core', msg: level })
  const text = terminalWriter('text', streams)
  text(line('info'))
  text(line('warn'))
  text(line('error'))
  text('不是 JSON')
  expect(stdout).toEqual([expect.stringMatching(/ INFO {2}core info\n$/), '不是 JSON\n'])
  expect(stderr).toEqual([
    expect.stringMatching(/ WARN {2}core warn\n$/),
    expect.stringMatching(/ ERROR core error\n$/),
  ])
  const json = terminalWriter('json', streams)
  json(line('debug'))
  expect(stdout.at(-1)).toBe(`${line('debug')}\n`)
})

test('同一个进程一份 root logger；捕获期间收下 debug、不写终端，restore 之后换回去', () => {
  expect(rootLogger()).toBe(rootLogger())
  const outer: string[] = []
  configureRootLogger({ level: 'warn', write: (line) => void outer.push(line) })
  const log = getLogger('auth')
  const logs = captureLogs()
  restores.push(logs.restore)
  log.debug('captured', { attempt: 1 })
  logs.restore()
  log.info('skipped')
  log.warn('kept')
  expect(logs.records).toMatchObject([{ level: 'debug', source: 'core', area: 'auth', attempt: 1, msg: 'captured' }])
  expect(outer.map((line) => (JSON.parse(line) as { msg: string }).msg)).toEqual(['kept'])
})
