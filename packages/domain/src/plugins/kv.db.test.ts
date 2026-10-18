import { toIsoTimestamp } from '@nextskin/db'
import { beforeEach, expect, test } from 'vitest'
import { PluginCallRejected } from './errors.ts'
import { createPluginKv, MAX_KV_VALUE_BYTES } from './kv.ts'
import { pluginEnvironment } from './plugins.test-helper.ts'

const env = pluginEnvironment()
beforeEach(async () => {
  const timestamp = toIsoTimestamp(new Date('2026-10-18T00:00:00.000Z'))
  await env.db
    .insertInto('plugins')
    .values(
      ['a', 'b'].map((id) => ({
        id,
        version: '1.0.0',
        is_enabled: 1,
        capabilities: '["storage.kv"]',
        package_hash: null,
        last_error: null,
        installed_at: timestamp,
        updated_at: timestamp,
      })),
    )
    .execute()
})

test('get/set/delete：JSON 值、覆盖和插件键隔离', async () => {
  const kv = createPluginKv(env.db, () => new Date())
  expect(await kv.get('a', 'key')).toBeNull()
  await kv.set('a', 'key', { nested: [1, true, null] })
  expect(await kv.get('a', 'key')).toEqual({ nested: [1, true, null] })
  expect(await kv.get('b', 'key')).toBeNull()
  await kv.set('b', 'key', 'B')
  await kv.set('a', 'key', 'A')
  expect(await kv.get('a', 'key')).toBe('A')
  await kv.delete('a', 'key')
  expect(await kv.get('a', 'key')).toBeNull()
  expect(await kv.get('b', 'key')).toBe('B')
})

test('TTL 到期读不到，cleanup 只清除过期行', async () => {
  let now = new Date('2026-10-18T00:00:00Z')
  const kv = createPluginKv(env.db, () => now)
  await kv.set('a', 'expired', 1, 2)
  await kv.set('a', 'later', 2, 3)
  await kv.set('b', 'forever', 3)
  now = new Date(now.getTime() + 2000)
  expect(await kv.get('a', 'expired')).toBeNull()
  expect(await kv.get('a', 'later')).toBe(2)
  expect(await env.db.selectFrom('plugin_kv').select('key').execute()).toHaveLength(3)
  await kv.cleanup()
  expect((await env.db.selectFrom('plugin_kv').select('key').execute()).map((r) => r.key).sort()).toEqual([
    'forever',
    'later',
  ])
})

test('64 KiB 按序列化后的 UTF-8 字节数限制，拒绝不写入', async () => {
  const kv = createPluginKv(env.db, () => new Date())
  await kv.set('a', 'limit', 'a'.repeat(MAX_KV_VALUE_BYTES - 2))
  await expect(kv.set('a', 'limit', 'a'.repeat(MAX_KV_VALUE_BYTES - 1))).rejects.toBeInstanceOf(PluginCallRejected)
  await expect(kv.set('a', 'unicode', '汉'.repeat(MAX_KV_VALUE_BYTES / 2))).rejects.toBeInstanceOf(PluginCallRejected)
  expect(await kv.get('a', 'limit')).toHaveLength(MAX_KV_VALUE_BYTES - 2)
  expect(await kv.get('a', 'unicode')).toBeNull()
})
