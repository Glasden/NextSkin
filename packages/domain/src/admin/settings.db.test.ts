import { generateKeyPairSync } from 'node:crypto'
import { beforeEach, expect, test, vi } from 'vitest'
import { setup } from '../closet/test-support.ts'
import { createCore, type MailTransport } from '../index.ts'
import { encodeSettingValue } from '../settings/codec.ts'
import { coreSettingsRegistry } from '../settings/registry.ts'
import { parseSigningKey } from '../yggdrasil/signing-key.ts'

const env = setup()
const secretKey = 'test-only-secret-key-with-at-least-32-characters'
const actor = () => ({ uid: env.actor.uid, ip: '198.51.100.7' })
beforeEach(async () => {
  await env.db().deleteFrom('audit_logs').execute()
  await env.db().updateTable('users').set({ role: 'superadmin' }).where('id', '=', env.actor.uid).execute()
})
function core(production = false, mailTransport?: MailTransport) {
  return createCore({
    db: env.db(),
    secretKey,
    production,
    mailTransport,
    now: () => new Date(env.now()),
    textureStorage: {
      lateDeleteWindowMs: 0,
      read: () => Promise.resolve(null),
      write: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      deleteTemp: () => Promise.resolve(),
    },
    imagePool: { close: () => Promise.resolve(), processUpload: vi.fn(), render: vi.fn() },
  })
}
async function audits() {
  const rows = await env.db().selectFrom('audit_logs').selectAll().orderBy('id').execute()
  return rows.map((row) => ({ ...row, details: JSON.parse(row.details) as Record<string, unknown> }))
}

test('写入按注册表顺序，schema 输出归一化，恢复默认值删行；相同值和空提交不写审计', async () => {
  expect(
    await env.core.admin.updateSettings(actor(), {
      'auth.registration.emailDomains': { mode: 'allow', domains: [' EXAMPLE.TEST '] },
      'site.name': 'New name',
    }),
  ).toEqual({ updated: ['site.name', 'auth.registration.emailDomains'] })
  expect(await env.core.settings.read(['site.name', 'auth.registration.emailDomains'])).toEqual({
    'site.name': 'New name',
    'auth.registration.emailDomains': { mode: 'allow', domains: ['example.test'] },
  })
  expect(await env.core.admin.updateSettings(actor(), { 'site.name': 'New name' })).toEqual({ updated: [] })
  expect(await env.core.admin.updateSettings(actor(), {})).toEqual({ updated: [] })
  expect(await audits()).toHaveLength(2)
  expect(await env.core.admin.updateSettings(actor(), { 'site.name': 'NextSkin' })).toEqual({ updated: ['site.name'] })
  expect(await env.db().selectFrom('settings').selectAll().where('key', '=', 'site.name').execute()).toEqual([])
  const entries = await audits()
  expect(entries[0]).toMatchObject({
    action: 'setting.update',
    subject_type: 'setting',
    subject_id: 0,
    ip: actor().ip,
    created_at: env.now(),
    details: { key: 'site.name', from: 'NextSkin', to: 'New name' },
  })
  expect(
    (await env.core.admin.listAudit(env.actor.uid, { page: 1 })).items.every((entry) => entry.subject.exists),
  ).toBe(true)
})

test('未知键和内部项请求无效；schema、refine 和写入 check 失败，全部不写且没有审计', async () => {
  for (const key of ['unknown', 'auth.legacyPasswordSalt', '__proto__']) {
    await expect(
      env.core.admin.updateSettings(actor(), { [key]: 'invalid', 'site.name': 'Not saved' }),
    ).rejects.toMatchObject({ code: 'invalid_request', fields: undefined })
  }
  const weakPem = generateKeyPairSync('rsa', { modulusLength: 1024 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString()
  const invalid = {
    'site.name': 'Not saved',
    'site.url': 'bad',
    'player.nameRegex': '[',
    'texture.nameRegex': '\\u{',
    'yggdrasil.signingKey': weakPem,
    'checkIn.score': { min: 5, max: 4 },
    'texture.contentPolicy': 'x'.repeat(20001),
  }
  await expect(env.core.admin.updateSettings(actor(), invalid)).rejects.toMatchObject({
    code: 'invalid_request',
    fields: [
      'site.url',
      'checkIn.score',
      'player.nameRegex',
      'texture.nameRegex',
      'texture.contentPolicy',
      'yggdrasil.signingKey',
    ],
  })
  expect((await env.core.settings.read(['site.name']))['site.name']).toBe('NextSkin')
  expect(await audits()).toEqual([])
  // check 只用于写入，坏的旧正则仍然可读。
  await env.setting('player.nameRegex', '[')
  expect(
    (await env.core.admin.settingsSection('content')).find((view) => view.key === 'player.nameRegex'),
  ).toMatchObject({ value: '[', unreadable: false })
})

test('提交失败时多项设置和审计整体回滚', async () => {
  const transaction = env.db().transaction.bind(env.db())
  const spy = vi.spyOn(env.db(), 'transaction').mockImplementation(() => {
    const builder = transaction(),
      execute = builder.execute.bind(builder)
    builder.execute = (run) =>
      execute(async (tx) => {
        await run(tx)
        const rows = await tx.selectFrom('audit_logs').select('id').execute()
        expect(rows).toHaveLength(2)
        throw new Error('模拟提交失败')
      })
    return builder
  })
  try {
    await expect(
      env.core.admin.updateSettings(actor(), { 'site.name': 'Rolled back', 'site.url': 'https://example.test' }),
    ).rejects.toThrow('模拟提交失败')
  } finally {
    spy.mockRestore()
  }
  expect(await env.core.settings.read(['site.name', 'site.url'])).toEqual({ 'site.name': 'NextSkin', 'site.url': '' })
  expect(await audits()).toEqual([])
})

test('机密项加密、查询不回传、同值跳过、清除删除；长文本审计只记 Unicode 字符数', async () => {
  await env.core.admin.updateSettings(actor(), {
    'mail.smtp.password': 'SECRET_CANARY',
    'site.announcement': '😀公告',
    'texture.contentPolicy': '政策',
  })
  const row = await env
    .db()
    .selectFrom('settings')
    .select('value')
    .where('key', '=', 'mail.smtp.password')
    .executeTakeFirstOrThrow()
  expect(row.value).not.toContain('SECRET_CANARY')
  expect((await env.core.settings.read(['mail.smtp.password']))['mail.smtp.password']).toBe('SECRET_CANARY')
  const views = await env.core.admin.settingsSection('mail')
  expect(views.find((view) => view.key === 'mail.smtp.password')).toEqual({
    key: 'mail.smtp.password',
    control: { kind: 'secret', multiline: false },
    isSet: true,
    generate: false,
    unreadable: false,
  })
  expect(JSON.stringify(views)).not.toContain('SECRET_CANARY')
  expect(
    await env.core.admin.updateSettings(actor(), {
      'mail.smtp.password': 'SECRET_CANARY',
      'site.announcement': '😀公告',
    }),
  ).toEqual({ updated: [] })
  expect((await audits()).map((row) => row.details)).toEqual([
    { key: 'site.announcement', fromLength: 0, toLength: 3 },
    { key: 'texture.contentPolicy', fromLength: 0, toLength: 2 },
    { key: 'mail.smtp.password', secret: true },
  ])
  await env.core.admin.updateSettings(actor(), { 'mail.smtp.password': '' })
  expect(await env.db().selectFrom('settings').selectAll().where('key', '=', 'mail.smtp.password').execute()).toEqual(
    [],
  )
  expect(JSON.stringify(await audits())).not.toMatch(/SECRET_CANARY|😀公告|政策/)
})

test('坏 JSON、schema 不符、错误加密密钥可查询并修复，审计标明改前值不可读', async () => {
  for (const stored of ['{bad', '42']) {
    await env.setting('site.name', 'temporary')
    await env.db().updateTable('settings').set({ value: stored }).where('key', '=', 'site.name').execute()
    expect((await env.core.admin.settingsSection('site')).find((view) => view.key === 'site.name')).toMatchObject({
      value: 'NextSkin',
      unreadable: true,
    })
    await env.core.admin.updateSettings(actor(), { 'site.name': 'NextSkin' })
    expect((await audits()).at(-1)?.details).toEqual({ key: 'site.name', from: null, to: 'NextSkin', unreadable: true })
    expect(await env.db().selectFrom('settings').selectAll().where('key', '=', 'site.name').execute()).toEqual([])
  }
  await env.setting('mail.smtp.password', 'old')
  await env
    .db()
    .updateTable('settings')
    .set({ value: encodeSettingValue('mail.smtp.password', 'UNREADABLE_SECRET', { secretKey: 'wrong'.repeat(10) }) })
    .where('key', '=', 'mail.smtp.password')
    .execute()
  expect(
    (await env.core.admin.settingsSection('mail')).find((view) => view.key === 'mail.smtp.password'),
  ).toMatchObject({ unreadable: true, isSet: false })
  await env.core.admin.updateSettings(actor(), { 'mail.smtp.password': 'fixed' })
  expect((await env.core.settings.read(['mail.smtp.password']))['mail.smtp.password']).toBe('fixed')
  expect((await audits()).at(-1)?.details).toEqual({ key: 'mail.smtp.password', secret: true })
})

test.each(['admin', 'user', 'banned'] as const)('%s 的三个设置用例都无权限；空提交也必须授权', async (role) => {
  await env.db().updateTable('users').set({ role }).where('id', '=', env.actor.uid).execute()
  for (const operation of [
    () => env.core.admin.updateSettings(actor(), {}),
    () => env.core.admin.generateSetting(actor(), 'yggdrasil.signingKey'),
    () => env.core.admin.sendTestMail(actor()),
  ])
    await expect(operation()).rejects.toMatchObject({ code: 'permission_denied' })
  expect(await audits()).toEqual([])
})

test('真实生成 4096 位密钥立即用于 Yggdrasil，不回传私钥；生成后在事务里再次授权', async () => {
  expect(await env.core.yggdrasil.getSigningKey()).toBeNull()
  const transaction = vi.spyOn(env.db(), 'transaction')
  // 验证真实异步生成时尚未开启写事务。
  const real = coreSettingsRegistry['yggdrasil.signingKey'].generate
  const spy = vi.spyOn(coreSettingsRegistry['yggdrasil.signingKey'], 'generate').mockImplementation(async () => {
    expect(transaction).not.toHaveBeenCalled()
    return real()
  })
  expect(await env.core.admin.generateSetting(actor(), 'yggdrasil.signingKey')).toEqual({
    updated: ['yggdrasil.signingKey'],
  })
  expect(transaction).toHaveBeenCalled()
  const pem = (await env.core.settings.read(['yggdrasil.signingKey']))['yggdrasil.signingKey']!
  expect(pem.startsWith('-----BEGIN PRIVATE KEY-----')).toBe(true)
  expect(parseSigningKey(pem)).not.toBeNull()
  expect((await env.core.yggdrasil.getSigningKey())?.publicKey).toBe(parseSigningKey(pem)?.publicKey)
  expect(await env.core.admin.configChecks()).toEqual({ missing: ['mail'] })
  const views = await env.core.admin.settingsSection('yggdrasil')
  expect(views[0]).toMatchObject({ generate: true, isSet: true })
  expect(JSON.stringify(views)).not.toContain('PRIVATE KEY')
  expect((await audits()).map((row) => row.details)).toEqual([
    { key: 'yggdrasil.signingKey', secret: true, generated: true },
  ])
  expect(JSON.stringify(await audits())).not.toContain('PRIVATE KEY')
  spy.mockImplementation(async () => {
    await env.db().updateTable('users').set({ role: 'admin' }).where('id', '=', env.actor.uid).execute()
    return pem
  })
  await expect(env.core.admin.generateSetting(actor(), 'yggdrasil.signingKey')).rejects.toMatchObject({
    code: 'permission_denied',
  })
  expect(await audits()).toHaveLength(1)
  spy.mockRestore()
  transaction.mockRestore()
})

test('没有声明生成的键一律请求无效，不写入', async () => {
  for (const key of ['unknown', 'auth.legacyPasswordSalt', 'site.name'])
    await expect(env.core.admin.generateSetting(actor(), key)).rejects.toMatchObject({ code: 'invalid_request' })
  expect(await audits()).toEqual([])
})

test('配置检查按环境和当前配置；测试邮件同步发往操作者，按收件人语言，网络发送在事务之外', async () => {
  expect(await env.core.admin.configChecks()).toEqual({ missing: ['mail', 'signingKey'] })
  expect(await core(true).admin.configChecks()).toEqual({ missing: ['siteUrl', 'mail', 'signingKey'] })
  const send = vi.fn<MailTransport['send']>().mockImplementation(async () => {
    // 若发送仍占着同一个 SQLite 事务，这里无法另开事务。
    await env
      .db()
      .transaction()
      .execute(async (tx) => {
        await tx.selectFrom('users').select('id').execute()
      })
    return { messageId: null }
  })
  const app = core(true, { send })
  await expect(app.admin.sendTestMail(actor())).rejects.toMatchObject({ code: 'mail_not_configured' })
  expect(send).not.toHaveBeenCalled()
  await env.setting('site.url', 'https://example.test')
  await env.setting('site.name', 'Test site')
  await env.setting('site.locale', 'en')
  await env.setting('mail.transport', 'smtp')
  // 一个 transport 还不够，发件地址也必须配置。
  expect(await app.admin.configChecks()).toEqual({ missing: ['mail', 'signingKey'] })
  await env.setting('mail.from', { address: 'sender@example.test', name: 'Sender' })
  expect(await app.admin.configChecks()).toEqual({ missing: ['signingKey'] })
  await env.db().updateTable('users').set({ locale: 'zh-CN' }).where('id', '=', env.actor.uid).execute()
  expect(await app.admin.sendTestMail(actor())).toEqual({ to: 'actor@example.test' })
  expect(send.mock.calls[0]?.[0]).toMatchObject({
    to: 'actor@example.test',
    subject: 'Test site 的测试邮件',
    from: { address: 'sender@example.test', name: 'Sender' },
  })
  expect(send.mock.calls[0]?.[0].html).toContain('lang="zh-CN"')
  await env.db().updateTable('users').set({ locale: null }).where('id', '=', env.actor.uid).execute()
  await app.admin.sendTestMail(actor())
  expect(send.mock.calls[1]?.[0].subject).toBe('Test email from Test site')
  expect(send.mock.calls[1]?.[0].text).toContain('actor')
  expect(await audits()).toEqual([])
  expect(await env.db().selectFrom('jobs').selectAll().execute()).toEqual([])
  send.mockRejectedValue(new Error('x'.repeat(350)))
  await expect(app.admin.sendTestMail(actor())).rejects.toMatchObject({
    code: 'mail_test_failed',
    params: { reason: 'x'.repeat(300) },
  })
  // SMTP 服务器在报错里回显密码时，密码和登录时发出的 base64 形式都不能回到浏览器
  await env.setting('mail.smtp', { host: 'smtp.example.test', port: 587, security: 'starttls', username: 'mailer' })
  await env.setting('mail.smtp.password', 'hunter2-secret')
  const plain = Buffer.from('\0mailer\0hunter2-secret').toString('base64')
  const login = Buffer.from('hunter2-secret').toString('base64')
  send.mockRejectedValue(new Error(`535 Invalid password hunter2-secret; AUTH PLAIN ${plain}; AUTH LOGIN ${login}`))
  const failure = (await app.admin.sendTestMail(actor()).catch((error: unknown) => error)) as {
    code: string
    params: { reason: string }
  }
  expect(failure.code).toBe('mail_test_failed')
  expect(failure.params.reason).toBe('535 Invalid password ******; AUTH PLAIN ******; AUTH LOGIN ******')
})

test('两个超级管理员同时保存同一项：后提交的为准，审计里的旧值首尾相接；同时写同一个值只记一次', async () => {
  const other = await env.user('other')
  await env.db().updateTable('users').set({ role: 'superadmin' }).where('id', '=', other.uid).execute()
  const rows = () =>
    env
      .db()
      .selectFrom('settings')
      .select('key')
      .where('namespace', '=', 'core')
      .where('key', '=', 'site.name')
      .execute()
  // 和默认值相同、库里也没有这一行：占位的行要删掉，不写审计
  expect(await env.core.admin.updateSettings(actor(), { 'site.name': 'NextSkin' })).toEqual({ updated: [] })
  expect(await rows()).toEqual([])
  // 先从默认值（没有行）开始，再从已经存了的值开始
  for (const start of [null, 'Stored']) {
    if (start) await env.core.admin.updateSettings(actor(), { 'site.name': start })
    await env.db().deleteFrom('audit_logs').execute()
    await Promise.all([
      env.core.admin.updateSettings(actor(), { 'site.name': 'Alpha' }),
      env.core.admin.updateSettings({ uid: other.uid, ip: null }, { 'site.name': 'Beta' }),
    ])
    const changes = (await audits()).map((row) => row.details)
    expect(changes).toHaveLength(2)
    expect(changes[0]?.from).toBe(start ?? 'NextSkin')
    expect(changes[1]?.from).toBe(changes[0]?.to)
    expect(changes[1]?.to).toBe((await env.core.settings.read(['site.name']))['site.name'])
  }
  await env.db().deleteFrom('audit_logs').execute()
  const same = await Promise.all([
    env.core.admin.updateSettings(actor(), { 'site.name': 'Same' }),
    env.core.admin.updateSettings({ uid: other.uid, ip: null }, { 'site.name': 'Same' }),
  ])
  expect(same.map((result) => result.updated.length).sort()).toEqual([0, 1])
  expect(await audits()).toHaveLength(1)
})
