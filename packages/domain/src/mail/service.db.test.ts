import { coreMigrations, migrateToLatest, toIsoTimestamp, upsert, writeAuthDate, type CoreDatabase } from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createCore, encodeSettingValue, type Core, type CoreSettingKey, type CoreSettingValue } from '../index.ts'
import type { MailMessage, MailTransport } from './types.ts'
import { MAIL_JOB } from './service.ts'

const secretKey = 'test-only-secret-key-with-at-least-32-characters'
let database: TestDatabase<CoreDatabase>
let core: Core
let uid: number
let send: MailTransport['send']
const messages: MailMessage[] = []
const lines: string[] = []

beforeAll(async () => {
  database = await createTestDatabase<CoreDatabase>()
  await migrateToLatest(database.db, coreMigrations)
})
afterAll(async () => database?.cleanup())
beforeEach(async () => {
  await database.db.deleteFrom('users').execute()
  await database.db.deleteFrom('settings').execute()
  await database.db.deleteFrom('jobs').execute()
  await database.db.deleteFrom('failed_jobs').execute()
  messages.length = 0
  lines.length = 0
  send = (message) => {
    messages.push(message)
    return Promise.resolve({ messageId: null })
  }
  core = createCore({
    db: database.db,
    secretKey,
    production: false,
    textureStorage: { read: () => Promise.resolve(null) },
    mailTransport: { send: (message) => send(message) },
    jobs: { log: (line) => lines.push(line) },
  })
  const now = writeAuthDate(database.db, toIsoTimestamp(new Date()))
  await database.db
    .insertInto('users')
    .values({
      nickname: '史蒂夫',
      email: 'steve@example.test',
      email_verified: false,
      locale: 'zh-CN',
      created_at: now,
      updated_at: now,
    })
    .execute()
  uid = (await database.db.selectFrom('users').select('id').executeTakeFirstOrThrow()).id
  await setting('mail.transport', 'smtp')
  await setting('mail.from', { address: 'sender@example.test', name: 'NextSkin' })
})

async function setting<K extends CoreSettingKey>(key: K, value: CoreSettingValue<K>) {
  await upsert(database.db, 'settings', {
    values: {
      namespace: 'core',
      key,
      value: encodeSettingValue(key, value, { secretKey }),
      updated_at: toIsoTimestamp(new Date()),
    },
    conflict: ['namespace', 'key'],
    update: ['value', 'updated_at'],
  })
}
const user = () => ({ id: String(uid), email: 'steve@example.test' })
const url = 'https://skin.example.test/reset-password/SECRET_TOKEN_CANARY'

test('send 只入队；发送时按收件人当前的昵称和语言渲染，发件人取当前设置', async () => {
  await core.mail.send('resetPassword', user(), url)
  expect(messages).toEqual([])
  const [job] = await database.db.selectFrom('jobs').selectAll().execute()
  expect(job?.name).toBe(MAIL_JOB)
  expect(JSON.parse(job!.payload)).toMatchObject({ template: 'resetPassword', to: 'steve@example.test', uid, url })
  await database.db.updateTable('users').set({ nickname: '改名后' }).execute()
  await setting('mail.from', { address: 'later@example.test', name: '' })
  await core.jobs.drain()
  expect(messages).toHaveLength(1)
  expect(messages[0]).toMatchObject({
    to: 'steve@example.test',
    from: { address: 'later@example.test', name: '' },
    subject: '重设你在 NextSkin 的密码',
  })
  expect(messages[0]!.text).toContain('改名后')
  expect(messages[0]!.text).toContain(url)
  expect(await database.db.selectFrom('jobs').selectAll().execute()).toEqual([])
})

test('没有配置邮件时 send 直接报错，不入队；入队后才关掉邮件的任务按失败重试', async () => {
  await setting('mail.transport', 'none')
  await expect(core.mail.send('verifyEmail', user(), url)).rejects.toMatchObject({ code: 'mail_not_configured' })
  expect(await database.db.selectFrom('jobs').selectAll().execute()).toEqual([])
  await setting('mail.transport', 'smtp')
  await core.mail.send('verifyEmail', user(), url)
  await setting('mail.transport', 'none')
  await core.jobs.drain()
  expect(messages).toEqual([])
  expect(await database.db.selectFrom('jobs').selectAll().execute()).toMatchObject([
    { attempts: 1, last_error: 'mail_not_configured' },
  ])
})

test('链接过期或用户已删除的任务直接完成，不发送', async () => {
  const expired = {
    template: 'verifyEmail',
    to: 'steve@example.test',
    uid,
    url,
    expiresAt: toIsoTimestamp(new Date(0)),
  }
  await core.jobs.enqueue(database.db, MAIL_JOB, expired)
  await core.mail.send('verifyEmail', user(), url)
  await database.db.deleteFrom('users').execute()
  await core.jobs.drain()
  expect(messages).toEqual([])
  expect(await database.db.selectFrom('jobs').selectAll().execute()).toEqual([])
  expect(await database.db.selectFrom('failed_jobs').selectAll().execute()).toEqual([])
})

test('发送失败到次数用完进死信：载荷去掉链接，错误和日志里没有收件内容和令牌', async () => {
  send = () => Promise.reject(new Error(`535 ${url} steve@example.test`))
  let clock = new Date()
  core = createCore({
    db: database.db,
    secretKey,
    production: false,
    textureStorage: { read: () => Promise.resolve(null) },
    mailTransport: { send: (message) => send(message) },
    jobs: { log: (line) => lines.push(line), now: () => clock },
  })
  await core.mail.send('resetPassword', user(), url)
  for (let attempt = 0; attempt < 5; attempt++) {
    await core.jobs.drain()
    clock = new Date(clock.getTime() + 3_600_000)
  }
  expect(await database.db.selectFrom('jobs').selectAll().execute()).toEqual([])
  const dead = await database.db.selectFrom('failed_jobs').selectAll().execute()
  expect(dead).toMatchObject([{ name: MAIL_JOB, attempts: 5, last_error: 'error' }])
  expect(JSON.parse(dead[0]!.payload)).toEqual({ template: 'resetPassword', to: 'steve@example.test', uid })
  expect(lines).toHaveLength(5)
  expect(JSON.stringify(lines)).not.toMatch(/SECRET_TOKEN_CANARY|steve@example|535/)
})
