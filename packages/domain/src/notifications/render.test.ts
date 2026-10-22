import { toIsoTimestamp } from '@nextskin/db'
import { expect, test, vi } from 'vitest'
import { renderNotification, type NotificationPlugins, type NotificationRow } from './render.ts'

const base: NotificationRow = {
  id: 1,
  user_id: 1,
  type: 'report.pending',
  params: '{}',
  broadcast_id: null,
  plugin_id: null,
  title_key: null,
  body_key: null,
  link: null,
  read_at: null,
  created_at: toIsoTimestamp(new Date('2030-01-01T00:00:00Z')),
  title: null,
  body: null,
}
const plugins: NotificationPlugins = {
  get: vi.fn(() => undefined),
  translate: vi.fn((_id, key, locale) => `${locale}:${key}`),
}
const view = (type: string, params: unknown) => ({ ...base, type, params: JSON.stringify(params) })

test('系统通知按两种语言渲染，标题、退还奖励和类型链接', () => {
  const resolved = view('report.resolved', {
    reportId: 1,
    tid: 2,
    textureName: 'Alex',
    outcome: 'resolved',
    refunded: 11,
    rewarded: 7,
  })
  expect(renderNotification(resolved, 'zh-CN', plugins)).toMatchObject({
    title: '举报已采纳',
    body: '你对材质「Alex」的举报已采纳，退还 11 积分，奖励 7 积分。',
    format: 'text',
    link: '/user/reports',
  })
  expect(renderNotification(resolved, 'en', plugins)).toMatchObject({
    title: 'Report accepted',
    body: 'Your report about the texture “Alex” was accepted. 11 points were refunded. You were awarded 7 points.',
  })
  const rejected = view('report.resolved', {
    reportId: 1,
    tid: 2,
    textureName: 'Alex',
    outcome: 'rejected',
    refunded: 0,
    rewarded: 0,
  })
  // 积分为 0 时不写
  expect(renderNotification(rejected, 'zh-CN', plugins)).toMatchObject({
    title: '举报已驳回',
    body: '你对材质「Alex」的举报已驳回。',
  })
  expect(renderNotification(rejected, 'en', plugins).title).toBe('Report rejected')
  expect(renderNotification(base, 'zh-CN', plugins)).toMatchObject({
    title: '有新的举报待处理',
    link: '/admin/reports',
  })
  expect(renderNotification(base, 'en', plugins).title).toBe('New reports need review')
  const removed = view('texture.removed', { tid: 12, name: 'Alex', action: 'unpublished' })
  expect(renderNotification(removed, 'zh-CN', plugins)).toMatchObject({
    title: '你的材质被下架了',
    link: '/skinlib/12',
  })
  expect(renderNotification(removed, 'en', plugins).title).toBe('Your texture was unpublished')
  const deleted = view('texture.removed', { tid: 12, name: 'Alex', action: 'deleted' })
  expect(renderNotification(deleted, 'zh-CN', plugins)).toMatchObject({ title: '你的材质被删除了', link: null })
  expect(renderNotification(deleted, 'en', plugins).title).toBe('Your texture was deleted')
})

test('账号改动逐项翻译为多行纯文本，按角色、应用、安全的顺序选择链接', () => {
  const row = view('account.changed', {
    changes: [
      { kind: 'password' },
      { kind: 'email', pending: true },
      { kind: 'twoFactor' },
      { kind: 'passkeys', count: 2 },
      { kind: 'binding', pluginId: 'gone', providerId: 'provider' },
      { kind: 'playerRenamed', from: 'Alex', to: 'Steve' },
      { kind: 'playerDeleted', name: 'A' },
      { kind: 'oauthClientDisabled', name: 'B' },
      { kind: 'oauthClientDeleted', name: 'C' },
      { kind: 'playerTransferredIn', name: 'D' },
      { kind: 'playerTransferredOut', name: 'E' },
    ],
  })
  const zh = renderNotification(row, 'zh-CN', plugins)
  expect(zh).toMatchObject({ title: '管理员修改了你的账号', format: 'text', link: '/user/players' })
  expect(zh.body!.split('\n')).toHaveLength(11)
  expect(zh.body).toContain('解除了 provider 账号的绑定')
  expect(renderNotification(row, 'en', plugins).body).toContain('Changed your email (effective after confirmation)')
  expect(
    renderNotification(view('account.changed', { changes: [{ kind: 'oauthClientDeleted', name: 'x' }] }), 'en', plugins)
      .link,
  ).toBe('/user/oauth-clients')
  expect(renderNotification(view('account.changed', { changes: [{ kind: 'password' }] }), 'zh-CN', plugins).link).toBe(
    '/user/security',
  )
})

test('message 使用群发原文和 Markdown；插件缺失时兜底，存在时翻译并保留站内链接', () => {
  expect(
    renderNotification({ ...base, type: 'message', title: 'Title', body: '**Markdown**' }, 'en', plugins),
  ).toMatchObject({ title: 'Title', body: '**Markdown**', format: 'markdown' })
  const row = {
    ...base,
    type: 'plugin',
    plugin_id: 'example',
    title_key: 'title',
    body_key: 'body',
    params: '{"n":2}',
    link: '/example',
  }
  expect(renderNotification(row, 'zh-CN', plugins)).toMatchObject({
    title: '来自插件 example 的通知',
    body: null,
    link: '/example',
  })
  expect(renderNotification(row, 'en', plugins).title).toBe('Notification from plugin example')
  const present = {
    get: vi.fn(() => ({
      manifest: { providers: { login: [{ id: 'provider', label: 'label' }] } },
    })) as unknown as NotificationPlugins['get'],
    translate: vi.fn((_id, key, locale) => `${locale}:${key}`),
  }
  expect(renderNotification(row, 'en', present)).toMatchObject({ title: 'en:title', body: 'en:body', format: 'text' })
  expect(present.translate).toHaveBeenCalledWith('example', 'body', 'en', { n: 2 })
  expect(renderNotification({ ...row, body_key: null }, 'zh-CN', present).body).toBe(null)
  const binding = view('account.changed', {
    changes: [{ kind: 'binding', pluginId: 'example', providerId: 'provider' }],
  })
  expect(renderNotification(binding, 'zh-CN', present).body).toBe('解除了 zh-CN:label 账号的绑定')
  expect(renderNotification(binding, 'en', present).body).toContain('en:label')
})
