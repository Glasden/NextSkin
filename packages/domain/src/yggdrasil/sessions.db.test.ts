import { expect, test, vi } from 'vitest'
import { createMemorySessionCache, normalizeIp, sessionCacheKey } from './sessions.ts'
import { setup } from './yggdrasil.test-helper.ts'

const s = setup()
const join = (
  accessToken: string | null,
  selectedProfile: string | null,
  ip: string | null = null,
  serverId: string | null = 'server',
) => s.core.yggdrasil.join({ accessToken, selectedProfile, ip, serverId })
const hasJoined = (username: string | null = 'Steve', ip: string | null = null, serverId: string | null = 'server') =>
  s.core.yggdrasil.hasJoined({ username, ip, serverId })

test('服务器路径隔离同名游戏 serverId 的 session cache', () => {
  expect(sessionCacheKey('same', null)).not.toBe(sessionCacheKey('same', 'server-a'))
  expect(sessionCacheKey('same', 'server-a')).not.toBe(sessionCacheKey('same', 'server-b'))
})

test('IP 规范化保留 null 和非法输入，统一 IPv4 映射和 IPv6 压缩', () => {
  expect(normalizeIp(null)).toBeNull()
  expect(normalizeIp('garbage')).toBe('garbage')
  expect(normalizeIp('::FFFF:1.2.3.4')).toBe('1.2.3.4')
  // 映射地址的另外几种合法写法
  expect(normalizeIp('0:0:0:0:0:ffff:192.0.2.1')).toBe('192.0.2.1')
  expect(normalizeIp('::ffff:c000:201')).toBe('192.0.2.1')
  expect(normalizeIp('1.2.3.4')).toBe('1.2.3.4')
  expect(normalizeIp('fe80::1%eth0')).toBe('fe80::1%eth0')
  expect(normalizeIp('2001:0DB8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8::1')
})

test('未绑定、角色不匹配、角色转让和封禁拒绝进服', async () => {
  const unbound = await s.login()
  await expect(join(unbound.accessToken, null)).rejects.toMatchObject({
    messageKey: 'yggdrasil.errors.profile_mismatch',
  })
  const player = await s.player(),
    token = await s.login()
  await expect(join(token.accessToken, 'a'.repeat(32))).rejects.toMatchObject({
    messageKey: 'yggdrasil.errors.profile_mismatch',
  })
  await expect(join(token.accessToken, player.uuid.toUpperCase())).rejects.toMatchObject({
    messageKey: 'yggdrasil.errors.profile_mismatch',
  })
  await expect(join(null, player.uuid)).rejects.toMatchObject({ messageKey: 'yggdrasil.errors.token_invalid' })
  await s.db().updateTable('users').set({ role: 'banned' }).where('id', '=', s.uid).execute()
  await expect(join(token.accessToken, player.uuid)).rejects.toMatchObject({
    messageKey: 'yggdrasil.errors.user_banned',
  })
  await s.db().updateTable('users').set({ role: 'user' }).where('id', '=', s.uid).execute()
  await s
    .db()
    .updateTable('players')
    .set({ user_id: await s.user('other@example.test') })
    .where('id', '=', player.pid)
    .execute()
  await expect(join(token.accessToken, player.uuid)).rejects.toMatchObject({
    messageKey: 'yggdrasil.errors.token_invalid',
  })
})

test.each([
  ['::ffff:1.2.3.4', '1.2.3.4'],
  ['2001:db8:0:0:0:0:0:1', '2001:db8::1'],
])('进服记录统一 IP %s 和 %s，可重复查询，严格比较当前名字', async (client, server) => {
  const player = await s.player(),
    token = await s.login()
  await join(token.accessToken, player.uuid, client)
  expect(await hasJoined('Steve', server)).toMatchObject({ pid: player.pid })
  expect(await hasJoined('Steve', server)).toMatchObject({ pid: player.pid })
  expect(await hasJoined('sTEVE', server)).toBeNull()
  expect(await hasJoined('Steve', '1.1.1.1')).toBeNull()
  expect(await hasJoined(null)).toBeNull()
  await s.core.players.update({ uid: s.uid }, player.pid, { name: 'Renamed' })
  expect(await hasJoined('Steve', server)).toBeNull()
  expect(await hasJoined('Renamed', server)).toMatchObject({ pid: player.pid })
})

test('空 serverId 按空字符串存，IP 可省略；120 秒时过期', async () => {
  const player = await s.player(),
    token = await s.login()
  await join(token.accessToken, player.uuid, null, null)
  expect(await hasJoined('Steve', '1.2.3.4', '')).toBeNull()
  expect(await hasJoined('Steve', null, '')).toMatchObject({ pid: player.pid })
  expect(await hasJoined('Steve', null, 'missing')).toBeNull()
  s.tick(119_999)
  expect(await hasJoined('Steve', null, null)).toMatchObject({ pid: player.pid })
  s.tick(1)
  expect(await hasJoined('Steve', null, '')).toBeNull()
})

test('同 serverId 覆盖旧记录，角色删除后不再返回', async () => {
  const first = await s.player(),
    token = await s.login()
  await join(token.accessToken, first.uuid)
  const uid = await s.user('other@example.test'),
    second = await s.player('Other', uid)
  const otherToken = await s.login({ username: 'other@example.test' })
  await join(otherToken.accessToken, second.uuid)
  expect(await hasJoined('Steve')).toBeNull()
  expect(await hasJoined('Other')).toMatchObject({ pid: second.pid })
  await s.core.players.delete({ uid }, second.pid)
  expect(await hasJoined('Other')).toBeNull()
})

test('没有订阅者时不开事务、不写任务；订阅后写入正确事件和 actor', async () => {
  const player = await s.player(),
    token = await s.login()
  await join(token.accessToken, player.uuid)
  const transaction = vi.spyOn(s.db(), 'transaction')
  expect(await hasJoined()).toMatchObject({ pid: player.pid })
  expect(transaction).not.toHaveBeenCalled()
  expect(await s.db().selectFrom('jobs').selectAll().execute()).toEqual([])
  s.core.events.subscribe('yggdrasil.serverJoined', 'test:joined', { run: () => Promise.resolve() })
  expect(await hasJoined()).toMatchObject({ pid: player.pid })
  expect(transaction).toHaveBeenCalledOnce()
  transaction.mockRestore()
  const row = await s.db().selectFrom('jobs').select('payload').executeTakeFirstOrThrow()
  expect(JSON.parse(row.payload)).toMatchObject({
    name: 'yggdrasil.serverJoined',
    occurredAt: s.now().toISOString(),
    actor: { kind: 'user', uid: s.uid, role: 'user' },
    data: { pid: player.pid, uuid: player.uuid, serverId: 'server' },
  })
})

test('两个核心可注入共享的进服缓存', async () => {
  const cache = createMemorySessionCache(s.now)
  const a = s.makeCore({ yggdrasilSessionCache: cache }),
    b = s.makeCore({ yggdrasilSessionCache: cache })
  const player = await s.player(),
    token = await s.login({}, a)
  await a.yggdrasil.join({ accessToken: token.accessToken, selectedProfile: player.uuid, ip: null, serverId: 'shared' })
  expect(await b.yggdrasil.hasJoined({ username: 'Steve', serverId: 'shared', ip: null })).toMatchObject({
    pid: player.pid,
  })
  s.tick(120_000)
  expect(await b.yggdrasil.hasJoined({ username: 'Steve', serverId: 'shared', ip: null })).toBeNull()
})
