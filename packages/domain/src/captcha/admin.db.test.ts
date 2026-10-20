import { beforeEach, expect, test, vi } from 'vitest'
import { setup } from '../closet/test-support.ts'

const env = setup()
const actor = () => ({ uid: env.actor.uid, ip: '198.51.100.7' })
beforeEach(async () => {
  await env.db().deleteFrom('audit_logs').execute()
  await env.db().updateTable('users').set({ role: 'superadmin' }).where('id', '=', env.actor.uid).execute()
})

test('系统停用复用设置写入和审计，重复调用不写；两个密钥保留且不出现在查询和审计里', async () => {
  await env.core.admin.updateSettings(actor(), {
    'captcha.provider': 'hcaptcha',
    'captcha.siteKey': 'site',
    'captcha.secretKey': 'SECRET_CANARY',
  })
  expect(
    (await env.core.admin.settingsSection('captcha')).find((item) => item.key === 'captcha.secretKey'),
  ).toMatchObject({ isSet: true })
  expect(JSON.stringify(await env.core.admin.settingsSection('captcha'))).not.toContain('SECRET_CANARY')
  const stored = await env
    .db()
    .selectFrom('settings')
    .select('value')
    .where('key', '=', 'captcha.secretKey')
    .executeTakeFirstOrThrow()
  expect(stored.value).not.toContain('SECRET_CANARY')
  const initial = await env.db().selectFrom('audit_logs').select('details').orderBy('id').execute()
  expect(initial.map((row) => JSON.parse(row.details) as unknown)).toContainEqual({
    key: 'captcha.secretKey',
    secret: true,
  })
  expect(JSON.stringify(initial)).not.toContain('SECRET_CANARY')
  await env.db().deleteFrom('audit_logs').execute()
  expect(await env.core.admin.disableCaptchaAsSystem()).toEqual({ changed: true })
  expect(await env.core.admin.disableCaptchaAsSystem()).toEqual({ changed: false })
  expect(await env.core.settings.read(['captcha.provider', 'captcha.siteKey', 'captcha.secretKey'])).toEqual({
    'captcha.provider': 'none',
    'captcha.siteKey': 'site',
    'captcha.secretKey': 'SECRET_CANARY',
  })
  const rows = await env.db().selectFrom('audit_logs').selectAll().execute()
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    actor_type: 'system',
    actor_user_id: null,
    actor_plugin_id: null,
    ip: null,
    action: 'setting.update',
    subject_type: 'setting',
    subject_id: 0,
  })
  expect(JSON.parse(rows[0]!.details)).toEqual({ key: 'captcha.provider', from: 'hcaptcha', to: 'none' })
  expect(await env.db().selectFrom('settings').selectAll().where('key', '=', 'captcha.provider').execute()).toEqual([])
})

test('两个系统调用同时停用只写一次审计；提交失败则设置和审计一起回滚', async () => {
  await env.setting('captcha.provider', 'recaptcha')
  const transaction = env.db().transaction.bind(env.db())
  const spy = vi.spyOn(env.db(), 'transaction').mockImplementationOnce(() => {
    const builder = transaction(),
      execute = builder.execute.bind(builder)
    builder.execute = (run) =>
      execute(async (tx) => {
        await run(tx)
        throw new Error('模拟提交失败')
      })
    return builder
  })
  await expect(env.core.admin.disableCaptchaAsSystem()).rejects.toThrow('模拟提交失败')
  spy.mockRestore()
  expect((await env.core.settings.read(['captcha.provider']))['captcha.provider']).toBe('recaptcha')
  expect(await env.db().selectFrom('audit_logs').selectAll().execute()).toEqual([])
  const results = await Promise.all([env.core.admin.disableCaptchaAsSystem(), env.core.admin.disableCaptchaAsSystem()])
  expect(results.map((item) => item.changed).sort()).toEqual([false, true])
  expect(await env.db().selectFrom('audit_logs').selectAll().execute()).toHaveLength(1)
})

test('配置检查只提示已选服务商但密钥缺失的配置，空白密钥也算缺失', async () => {
  expect((await env.core.admin.configChecks()).missing).not.toContain('captcha')
  await env.setting('captcha.provider', 'turnstile')
  for (const [site, secret] of [
    ['', ''],
    ['site', ''],
    ['', 'secret'],
    ['site', ' '],
  ]) {
    await env.setting('captcha.siteKey', site!)
    await env.setting('captcha.secretKey', secret!)
    expect((await env.core.admin.configChecks()).missing).toContain('captcha')
    expect(await env.core.captcha.publicConfig()).toBeNull()
  }
  await env.setting('captcha.secretKey', 'secret')
  expect((await env.core.admin.configChecks()).missing).not.toContain('captcha')
  expect(await env.core.captcha.publicConfig()).toEqual({ provider: 'turnstile', siteKey: 'site', invisible: false })
})

test.each(['admin', 'user', 'banned'] as const)('后台测试验证码重新授权，%s 不得调用核对', async (role) => {
  await env.db().updateTable('users').set({ role }).where('id', '=', env.actor.uid).execute()
  const check = vi.spyOn(env.core.captcha, 'test')
  await expect(env.core.admin.testCaptcha(actor(), { token: 'token', ip: null })).rejects.toMatchObject({
    code: 'permission_denied',
  })
  expect(check).not.toHaveBeenCalled()
  expect(await env.db().selectFrom('audit_logs').selectAll().execute()).toEqual([])
})

test('后台测试核对在事务外执行，三种结果原样返回且不写审计', async () => {
  const input = { token: 'token', ip: '198.51.100.7' }
  const check = vi.spyOn(env.core.captcha, 'test')
  for (const result of ['passed', 'failed', 'unavailable'] as const) {
    check.mockImplementationOnce(async () => {
      // 同一个连接可以另开事务，证明没有占着授权事务等核对。
      await env
        .db()
        .transaction()
        .execute(async (tx) => {
          await tx.selectFrom('users').select('id').execute()
        })
      return { result, errorCodes: ['test-code'] }
    })
    expect(await env.core.admin.testCaptcha(actor(), input)).toEqual({ result, errorCodes: ['test-code'] })
    expect(check).toHaveBeenLastCalledWith(input)
  }
  expect(await env.db().selectFrom('audit_logs').selectAll().execute()).toEqual([])
})
