import { toIsoTimestamp, upsert } from '@nextskin/db'
import { definePlugin } from '@nextskin/plugin-sdk'
import { checkTheme, contrastRatio, resolveTheme, themeCss } from '@nextskin/theme'
import { buildManifest, packPluginPackage, sha256Hex } from '@nextskin/plugin-host'
import { expect, test } from 'vitest'
import { official, pluginEnvironment } from '../plugins/plugins.test-helper.ts'
import { encodeSettingValue } from '../settings/codec.ts'

const env = pluginEnvironment()
const contribution = (name: string) => ({ name, label: `themes.${name}`, colors: {} })
const palette = (id: string) =>
  official(
    id,
    definePlugin({
      capabilities: [],
      on: { 'user.profileUpdated': async () => {} },
      ui: { themes: [contribution('one'), contribution('two')] },
    }),
  )
const settings = () => env.core.settings.read(['theme.default', 'theme.enabled'])
const audits = async () =>
  (
    await env.db
      .selectFrom('audit_logs')
      .select(['details', 'actor_user_id', 'ip'])
      .where('action', '=', 'setting.update')
      .orderBy('id')
      .execute()
  ).map((row) => ({ ...row, details: JSON.parse(row.details) as unknown }))
async function boot() {
  await env.boot([palette('b'), palette('a')])
  const actor = await env.actor()
  await env.core.plugins.admin.enable(actor, 'a')
  await env.core.plugins.admin.enable(actor, 'b')
  return actor
}

test('钻石青、插件 id 和声明顺序；新主题默认不启用，小样有 CSS，根布局省略钻石青 CSS', async () => {
  const actor = await boot()
  const view = await env.core.themes.adminView(actor)
  expect(view.themes.map((theme) => theme.id)).toEqual(['diamond', 'a/one', 'a/two', 'b/one', 'b/two'])
  expect(view.themes.map((theme) => theme.enabled)).toEqual([true, false, false, false, false])
  expect(view.themes[0]).toMatchObject({
    pluginId: null,
    label: 'diamond',
    default: true,
    css: themeCss('diamond', resolveTheme()),
  })
  expect(view.themes[1]).toMatchObject({ pluginId: 'a', label: 'themes.one', css: themeCss('a/one', resolveTheme()) })
  expect(await env.core.themes.current(null)).toEqual({ id: 'diamond', css: null })
  expect(await env.core.themes.selectableCount()).toBe(1)
})

test('用户可选、跟随默认、已失效的选择和默认不可用时回落；读不改写存着的值', async () => {
  const actor = await boot()
  await env.core.themes.update(actor, { default: 'a/one' })
  await env.core.themes.update(actor, { enable: 'b/one' })
  await env.core.themes.setTheme(actor, 'b/one')
  expect(await env.core.themes.current(actor.uid)).toEqual({ id: 'b/one', css: themeCss('b/one', resolveTheme()) })
  expect((await env.core.themes.current(null)).id).toBe('a/one')
  await env.core.themes.update(actor, { disable: 'b/one' })
  expect(await env.core.themes.userView(actor.uid)).toMatchObject({
    selected: 'b/one',
    stale: true,
    current: 'a/one',
    siteDefault: 'a/one',
  })
  await env.core.themes.update(actor, { disable: 'diamond' })
  await env.core.plugins.admin.disable(actor, 'a')
  expect(await env.core.themes.current(actor.uid)).toEqual({ id: 'diamond', css: null })
  expect(await settings()).toEqual({ 'theme.default': 'a/one', 'theme.enabled': ['a/one'] })
  expect((await env.core.themes.userView(actor.uid)).selected).toBe('b/one')
  expect(await env.core.themes.selectableCount()).toBe(0)
})

test('选择必须启用且可用，null 清空；不发事件和审计，封禁与无账号不能改', async () => {
  const actor = await boot()
  const outbox = () => env.db.selectFrom('jobs').selectAll().where('name', 'like', '%:on:user.profileUpdated').execute()
  const before = await outbox()
  const auditBefore = await env.db.selectFrom('audit_logs').selectAll().execute()
  expect(await env.core.themes.setTheme(actor, 'diamond')).toEqual({ theme: 'diamond' })
  await expect(env.core.themes.setTheme(actor, 'a/one')).rejects.toMatchObject({ code: 'theme_not_found' })
  await expect(env.core.themes.setTheme(actor, 'gone/theme')).rejects.toMatchObject({ code: 'theme_not_found' })
  expect(await env.core.themes.setTheme(actor, null)).toEqual({ theme: null })
  expect(await env.core.themes.userView(actor.uid)).toMatchObject({ selected: null, stale: false, current: 'diamond' })
  expect(await outbox()).toEqual(before)
  expect(await env.db.selectFrom('audit_logs').selectAll().execute()).toEqual(auditBefore)
  await env.db.updateTable('users').set({ role: 'banned' }).where('id', '=', actor.uid).execute()
  await expect(env.core.themes.setTheme(actor, null)).rejects.toMatchObject({ code: 'user_banned' })
  await expect(env.core.themes.setTheme({ uid: 2147483647 }, null)).rejects.toMatchObject({ code: 'unauthenticated' })
})

test('增量更新和审计：默认一并启用，禁止关默认，关未启用的无事发生，默认值不落库', async () => {
  const actor = await boot()
  await expect(env.core.themes.update(actor, { disable: 'diamond' })).rejects.toMatchObject({
    code: 'theme_default_disabled',
  })
  expect(await env.core.themes.update(actor, { default: 'a/one' })).toEqual({
    default: 'a/one',
    enabled: ['diamond', 'a/one'],
  })
  expect((await audits()).map((row) => row.details)).toEqual([
    { key: 'theme.default', from: 'diamond', to: 'a/one' },
    { key: 'theme.enabled', from: ['diamond'], to: ['diamond', 'a/one'] },
  ])
  for (const row of await audits()) expect(row).toMatchObject({ actor_user_id: actor.uid, ip: actor.ip })
  await env.core.themes.update(actor, { default: 'a/one' })
  await env.core.themes.update(actor, { enable: 'a/one' })
  await env.core.themes.update(actor, { disable: 'missing/theme' })
  expect(await audits()).toHaveLength(2)
  await expect(env.core.themes.update(actor, { enable: 'missing/theme' })).rejects.toMatchObject({
    code: 'theme_not_found',
  })
  await expect(env.core.themes.update(actor, { default: 'missing/theme' })).rejects.toMatchObject({
    code: 'theme_not_found',
  })
  await env.core.themes.update(actor, { default: 'diamond' })
  await env.core.themes.update(actor, { disable: 'a/one' })
  expect(
    await env.db
      .selectFrom('settings')
      .select('key')
      .where('namespace', '=', 'core')
      .where('key', 'in', ['theme.default', 'theme.enabled'])
      .execute(),
  ).toEqual([])
})

test('两个超级管理员同时启用、启用与设默认都保留对方的增量', async () => {
  const actor = await boot()
  const other = await env.actor()
  await Promise.all([
    env.core.themes.update(actor, { enable: 'a/one' }),
    env.core.themes.update(other, { enable: 'b/one' }),
  ])
  expect((await settings())['theme.enabled'].sort()).toEqual(['a/one', 'b/one', 'diamond'])
  await Promise.all([
    env.core.themes.update(actor, { default: 'a/two' }),
    env.core.themes.update(other, { enable: 'b/two' }),
  ])
  expect((await settings())['theme.enabled'].sort()).toEqual(['a/one', 'a/two', 'b/one', 'b/two', 'diamond'])
  expect((await settings())['theme.default']).toBe('a/two')
  expect(await audits()).toHaveLength(5)
})

test('停用不清引用，默认和用户选择重新启用后恢复，暂时用不上的条目可以关掉', async () => {
  const actor = await boot()
  await env.core.themes.update(actor, { default: 'a/one' })
  await env.core.themes.update(actor, { enable: 'a/two' })
  await env.core.themes.setTheme(actor, 'a/two')
  const before = await settings()
  await env.core.plugins.admin.disable(actor, 'a')
  expect(await settings()).toEqual(before)
  expect(await env.core.themes.adminView(actor)).toMatchObject({ default: 'diamond', missing: ['a/one', 'a/two'] })
  expect(await env.core.themes.userView(actor.uid)).toMatchObject({
    selected: 'a/two',
    stale: true,
    current: 'diamond',
  })
  await expect(env.core.themes.setTheme(actor, 'a/two')).rejects.toMatchObject({ code: 'theme_not_found' })
  await expect(env.core.themes.update(actor, { default: 'a/one' })).rejects.toMatchObject({ code: 'theme_not_found' })
  await expect(env.core.themes.update(actor, { disable: 'a/one' })).rejects.toMatchObject({
    code: 'theme_default_disabled',
  })
  await env.core.themes.update(actor, { disable: 'a/two' })
  await env.core.plugins.admin.enable(actor, 'a')
  expect((await env.core.themes.current(actor.uid)).id).toBe('a/one')
  await env.core.themes.update(actor, { enable: 'a/two' })
  expect((await env.core.themes.current(actor.uid)).id).toBe('a/two')
})

test('管理员权限从数据库查；普通设置接口拒绝主题键', async () => {
  await boot()
  const admin = await env.actor('admin')
  await expect(env.core.themes.adminView(admin)).rejects.toMatchObject({ code: 'permission_denied' })
  await expect(env.core.themes.update(admin, { default: 'diamond' })).rejects.toMatchObject({
    code: 'permission_denied',
  })
  const actor = await env.actor()
  await expect(env.core.admin.updateSettings(actor, { 'theme.default': 'a/one' })).rejects.toMatchObject({
    code: 'invalid_request',
  })
  await expect(env.core.admin.updateSettings(actor, { 'theme.enabled': [] })).rejects.toMatchObject({
    code: 'invalid_request',
  })
})

test('加载时检查只隔离坏主题，插件其他功能照常；换代重建主题缓存', async () => {
  const badColors = { light: { text: resolveTheme().light['text-inverse'] } } as const
  const definition = (bad: boolean) =>
    definePlugin({
      capabilities: [],
      routes: { 'GET /ping': { auth: 'public', handler: () => Promise.resolve(Response.json({ ok: true })) } },
      ui: { themes: [contribution('good'), { name: 'bad', label: 'themes.bad', colors: bad ? badColors : {} }] },
    })
  await env.boot([official('a', definition(true))])
  const actor = await env.actor()
  await env.core.plugins.admin.enable(actor, 'a')
  expect(env.core.plugins.isActive('a')).toBe(true)
  const response = await env.core.plugins.route({
    pluginId: 'a',
    method: 'GET',
    path: '/ping',
    user: null,
    locale: 'en',
    ip: '192.0.2.1',
    request: { method: 'GET', url: 'https://skin.example.test/plugins/a/ping', headers: [], body: null },
  })
  expect(response.status).toBe(200)
  expect(JSON.parse(new TextDecoder().decode(response.body))).toEqual({ ok: true })
  const view = await env.core.themes.adminView(actor)
  expect(view.themes.map((theme) => theme.id)).toEqual(['diamond', 'a/good'])
  expect(view.invalid).toEqual([
    { id: 'a/bad', pluginId: 'a', label: 'themes.bad', issues: checkTheme(resolveTheme(badColors)) },
  ])
  await expect(env.core.themes.update(actor, { enable: 'a/bad' })).rejects.toMatchObject({ code: 'theme_not_found' })
  await env.boot([official('a', definition(false))])
  expect((await env.core.themes.adminView(actor)).invalid).toEqual([])
  await env.core.themes.update(actor, { enable: 'a/bad' })
})

test('安装和升级重新检查包里的主题，拒绝绕过构建工具的坏配色', async () => {
  await env.boot([])
  const actor = await env.actor()
  const server = new TextEncoder().encode('export default {}')
  const files = new Map([['server.mjs', server]])
  const manifest = {
    ...buildManifest(definePlugin({ capabilities: [] }), {
      name: 'palette',
      version: '1.0.0',
      nextskin: { id: 'palette' },
    }),
    entry: { server: 'server.mjs' },
    integrity: { 'server.mjs': sha256Hex(server) },
  }
  for (const version of ['1.0.0', '1.1.0']) {
    const tampered = packPluginPackage({
      manifest: {
        ...manifest,
        version,
        ui: {
          ...manifest.ui,
          themes: [
            { name: 'bad', label: 'themes.bad', colors: { light: { text: resolveTheme().light['text-inverse'] } } },
          ],
        },
      },
      files,
    })
    await expect(env.core.plugins.admin.preview(actor, tampered)).rejects.toMatchObject({
      code: 'plugin_theme_invalid',
      params: {
        theme: 'bad',
        mode: 'light',
        check: 'contrast',
        pair: 'text / bg',
        values: `${resolveTheme().light['text-inverse']} / ${resolveTheme().light.bg}`,
        actual: contrastRatio(resolveTheme().light['text-inverse'], resolveTheme().light.bg).toFixed(2),
        minimum: '4.50',
      },
    })
    await expect(env.core.plugins.admin.install(actor, tampered, sha256Hex(tampered))).rejects.toMatchObject({
      code: 'plugin_theme_invalid',
    })
    // 只需已有插件记录就能覆盖升级的 inspect 路径，不为坏包启动 host。
    if (version === '1.0.0')
      await env.db
        .insertInto('plugins')
        .values({
          id: 'palette',
          version,
          is_enabled: 0,
          capabilities: '[]',
          installed_at: toIsoTimestamp(new Date()),
          updated_at: toIsoTimestamp(new Date()),
        })
        .execute()
  }
  const danger = resolveTheme().light.danger
  const tampered = packPluginPackage({
    manifest: {
      ...manifest,
      version: '1.1.0',
      ui: { ...manifest.ui, themes: [{ name: 'close', label: 'themes.close', colors: { light: { accent: danger } } }] },
    },
    files,
  })
  await expect(env.core.plugins.admin.preview(actor, tampered)).rejects.toMatchObject({
    code: 'plugin_theme_invalid',
    params: {
      theme: 'close',
      mode: 'light',
      check: 'distance',
      pair: 'accent / danger',
      values: `${danger} / ${danger}`,
      actual: '0.000',
      minimum: '0.120',
    },
  })
})

test('卸载同一事务清掉默认、启用列表和全部用户引用，审计记用户数，保留别的插件', async () => {
  await env.boot([palette('other')])
  const actor = await env.actor()
  const second = await env.actor()
  await env.core.plugins.admin.enable(actor, 'other')
  // 本实例取不到包时也必须能卸载，引用包括旧版本已去掉的主题。
  const timestamp = toIsoTimestamp(new Date())
  await env.db
    .insertInto('plugins')
    .values({
      id: 'palette',
      version: '1.0.0',
      is_enabled: 0,
      capabilities: '[]',
      package_hash: 'a'.repeat(64),
      installed_at: timestamp,
      updated_at: timestamp,
    })
    .execute()
  for (const key of ['theme.default', 'theme.enabled'] as const) {
    await upsert(env.db, 'settings', {
      values: {
        namespace: 'core',
        key,
        value: encodeSettingValue(
          key,
          key === 'theme.default' ? 'palette/one' : ['palette/one', 'palette/old', 'other/one'],
          { secretKey: env.secretKey },
        ),
        updated_at: timestamp,
      },
      conflict: ['namespace', 'key'],
      update: ['value', 'updated_at'],
    })
  }
  await env.db.updateTable('users').set({ theme: 'palette/one' }).where('id', '=', actor.uid).execute()
  await env.db.updateTable('users').set({ theme: 'palette/old' }).where('id', '=', second.uid).execute()
  const count = (await audits()).length
  await env.core.plugins.admin.uninstall(actor, 'palette')
  expect(await settings()).toEqual({ 'theme.default': 'diamond', 'theme.enabled': ['other/one', 'diamond'] })
  expect(await env.db.selectFrom('users').select('theme').where('id', 'in', [actor.uid, second.uid]).execute()).toEqual(
    [{ theme: null }, { theme: null }],
  )
  expect((await audits()).slice(count).map((row) => row.details)).toEqual([
    { key: 'theme.default', from: 'palette/one', to: 'diamond' },
    { key: 'theme.enabled', from: ['palette/one', 'palette/old', 'other/one'], to: ['other/one', 'diamond'] },
  ])
  const audit = await env.db
    .selectFrom('audit_logs')
    .select('details')
    .where('action', '=', 'plugin.uninstall')
    .executeTakeFirstOrThrow()
  expect(JSON.parse(audit.details)).toMatchObject({ plugin: 'palette', themeUsers: 2 })
})
