import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  coreMigrations,
  countRows,
  insertReturningId,
  migrateToLatest,
  readAuthBoolean,
  toIsoTimestamp,
  upsert,
  type CoreDatabase,
} from '@nextskin/db'
import { createTestDatabase, removeTestDirectory, type TestDatabase } from '@nextskin/db/testing'
import { verifyPassword } from 'better-auth/crypto'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'
import { createCore, createLocalTextureStorage, encodeSettingValue, type Core } from '../index.ts'
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../auth/password-policy.ts'
import { isSiteInitialized } from './initialized.ts'
import type { CreateSiteInput } from './service.ts'

const secretKey = 'setup-test-secret-with-at-least-32-characters'
let database: TestDatabase<CoreDatabase>
let directory: string
let file: string
let core: Core
beforeAll(async () => {
  database = await createTestDatabase<CoreDatabase>()
  await migrateToLatest(database.db, coreMigrations)
})
afterAll(async () => database?.cleanup())
beforeEach(async () => {
  for (const table of ['users', 'import_runs', 'settings', 'audit_logs', 'jobs'] as const)
    await database.db.deleteFrom(table).execute()
  directory = await mkdtemp(join(tmpdir(), 'nextskin-setup-'))
  file = join(directory, 'nested', 'setup-code')
  core = createCore({
    db: database.db,
    secretKey,
    production: false,
    setupCodeFile: file,
    textureStorage: createLocalTextureStorage(join(directory, 'textures')),
  })
})
afterEach(async () => {
  await core?.shutdown()
  await removeTestDirectory(directory)
})
async function input(overrides: Partial<CreateSiteInput> = {}): Promise<CreateSiteInput> {
  await core.setup.prepareCode()
  const token = await core.setup.verifyCode(await readFile(file, 'utf8'))
  return {
    setupToken: token!,
    siteName: '  My Site  ',
    siteUrl: 'https://skin.example.test///',
    email: ' Admin@Example.Test ',
    nickname: ' Owner ',
    password: 'correct horse battery staple',
    ip: '192.0.2.1',
    locale: 'en',
    ...overrides,
  }
}

test('安装码原子生成、权限、沿用、坏格式重建、删掉后换码', async () => {
  expect(await core.setup.prepareCode()).toEqual({ status: 'created', file })
  const code = await readFile(file, 'utf8')
  expect(code.trim()).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){3}$/)
  if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
  expect(await core.setup.prepareCode()).toEqual({ status: 'kept', file })
  expect(await readFile(file, 'utf8')).toBe(code)
  await writeFile(file, 'invalid')
  expect((await core.setup.prepareCode())?.status).toBe('created')
  const replacement = await readFile(file, 'utf8')
  expect(replacement).not.toBe(code)
  await rm(file)
  expect((await core.setup.prepareCode())?.status).toBe('created')
  expect(await readFile(file, 'utf8')).not.toBe(replacement)
})

test('规范化验证安装码和会话，每次读取文件，缺文件和错码都拒绝', async () => {
  expect(await core.setup.verifyCode('wrong')).toBeNull()
  expect(await core.setup.verifySession('wrong')).toBe(false)
  const value = await input()
  const code = await readFile(file, 'utf8')
  const normalized = ` \n ${code.toLowerCase().replaceAll('-', ' \t ')} `
  expect(await core.setup.verifyCode(normalized)).toBe(value.setupToken)
  expect(await core.setup.verifySession(value.setupToken)).toBe(true)
  expect(await core.setup.verifyCode('WRONG-CODE')).toBeNull()
  expect(await core.setup.verifySession(value.setupToken + 'x')).toBe(false)
  await core.setup.removeCode()
  await core.setup.removeCode()
  expect(await core.setup.verifySession(value.setupToken)).toBe(false)
  await core.setup.prepareCode()
  expect(await core.setup.verifySession(value.setupToken)).toBe(false)
})

test('创建超级管理员：凭据、设置、积分、审计、事件一起提交，提交后删除安装码', async () => {
  await upsert(database.db, 'settings', {
    values: {
      namespace: 'core',
      key: 'user.initialScore',
      value: encodeSettingValue('user.initialScore', 123, { secretKey }),
      updated_at: toIsoTimestamp(new Date()),
    },
    conflict: ['namespace', 'key'],
    update: ['value'],
  })
  core.events.subscribe('user.registered', 'test:registered', { run: async () => {} })
  const value = await input()
  const { uid } = await core.setup.createSite(value)
  const user = await database.db.selectFrom('users').selectAll().where('id', '=', uid).executeTakeFirstOrThrow()
  expect(user).toMatchObject({
    nickname: 'Owner',
    email: 'admin@example.test',
    role: 'superadmin',
    registration_ip: '192.0.2.1',
    locale: 'en',
    score: 123,
  })
  expect(readAuthBoolean(user.email_verified)).toBe(true)
  const account = await database.db
    .selectFrom('accounts')
    .selectAll()
    .where('user_id', '=', uid)
    .executeTakeFirstOrThrow()
  expect(account).toMatchObject({ provider_id: 'credential', account_id: String(uid) })
  expect(await verifyPassword({ hash: account.password!, password: value.password })).toBe(true)
  expect(await core.settings.read(['site.name', 'site.url'])).toEqual({
    'site.name': 'My Site',
    'site.url': 'https://skin.example.test',
  })
  expect(await database.db.selectFrom('score_transactions').select(['delta', 'balance', 'reason']).execute()).toEqual([
    { delta: 123, balance: 123, reason: 'score.reasons.initial' },
  ])
  expect(
    await database.db
      .selectFrom('audit_logs')
      .select(['action', 'actor_user_id', 'subject_type', 'subject_id', 'details'])
      .execute(),
  ).toEqual([
    {
      action: 'site.setup',
      actor_user_id: uid,
      subject_type: 'user',
      subject_id: uid,
      details: JSON.stringify({ nickname: 'Owner' }),
    },
  ])
  const job = await database.db.selectFrom('jobs').select('payload').executeTakeFirstOrThrow()
  expect(JSON.parse(job.payload)).toMatchObject({
    name: 'user.registered',
    actor: { kind: 'user', uid, role: 'superadmin' },
    data: { user: { uid, nickname: 'Owner', role: 'superadmin' }, extra: {} },
  })
  await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await core.setup.isInitialized()).toBe(true)
  expect(await core.setup.verifyCode('anything')).toBeNull()
  expect(await core.setup.verifySession(value.setupToken)).toBe(false)
  await expect(core.setup.createSite(value)).rejects.toMatchObject({ code: 'setup_completed' })
  await writeFile(file, 'residue')
  expect(await core.setup.prepareCode()).toEqual({ status: 'initialized', file })
  await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  await core.setup.prepareCode()
  await core.admin.requirePermission(uid, 'import.manage')
  await database.db.updateTable('users').set({ role: 'admin' }).where('id', '=', uid).execute()
  await expect(core.admin.requirePermission(uid, 'import.manage')).rejects.toMatchObject({ code: 'permission_denied' })
  await expect(core.admin.requirePermission(uid + 1, 'import.manage')).rejects.toMatchObject({
    code: 'unauthenticated',
  })
})

test('两次并发安装只有一个事务写入', async () => {
  const value = await input()
  const results = await Promise.allSettled([
    core.setup.createSite(value),
    core.setup.createSite({ ...value, email: 'other@example.test' }),
  ])
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'setup_completed' } })
  expect(await countRows(database.db.selectFrom('users'))).toBe(1)
})

test.each([
  ['setup_code_required', { setupToken: 'wrong' }],
  ['site_name_invalid', { siteName: '  ' }],
  ['site_name_invalid', { siteName: '界'.repeat(65) }],
  ['site_url_invalid', { siteUrl: '' }],
  ['site_url_invalid', { siteUrl: 'ftp://a.test' }],
  ['email_invalid', { email: 'bad' }],
  ['nickname_invalid', { nickname: ' ' }],
  ['password_too_short', { password: 'a'.repeat(MIN_PASSWORD_LENGTH - 1) }],
  ['password_too_long', { password: 'a'.repeat(MAX_PASSWORD_LENGTH + 1) }],
] as const)('新站校验：%s', async (code, overrides) => {
  await expect(core.setup.createSite(await input(overrides))).rejects.toMatchObject({ code })
  expect(await countRows(database.db.selectFrom('users'))).toBe(0)
})

test('只有成功的真实导入算初始化，完成时间为空也算', async () => {
  const id = await insertReturningId(database.db, 'import_runs', {
    status: 'succeeded',
    is_dry_run: 1,
    entry: 'cli',
    source: '{}',
    started_at: toIsoTimestamp(new Date()),
  })
  expect(await isSiteInitialized(database.db)).toBe(false)
  await database.db.updateTable('import_runs').set({ is_dry_run: 0, status: 'failed' }).where('id', '=', id).execute()
  expect(await isSiteInitialized(database.db)).toBe(false)
  await database.db.updateTable('import_runs').set({ status: 'succeeded' }).where('id', '=', id).execute()
  expect(await isSiteInitialized(database.db)).toBe(true)
  await core.setup.prepareCode()
  await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('没配置安装码文件时不准备文件', async () => {
  const other = createCore({
    db: database.db,
    secretKey,
    production: false,
    textureStorage: createLocalTextureStorage(directory),
  })
  try {
    expect(await other.setup.prepareCode()).toBeNull()
    expect(await other.setup.verifyCode('x')).toBeNull()
  } finally {
    await other.shutdown()
  }
})
