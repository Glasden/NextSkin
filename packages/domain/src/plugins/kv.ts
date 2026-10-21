import { toIsoTimestamp, upsert, type CoreDatabase } from '@nextskin/db'
import type { Json } from '@nextskin/plugin-sdk'
import type { Kysely } from 'kysely'
import { isStorageKey } from '../text.ts'
import { PluginCallRejected } from './errors.ts'

/** 单个值序列化后的上限，同插件任务的载荷（ADR-0033） */
export const MAX_KV_VALUE_BYTES = 64 * 1024
const MAX_TTL_SEC = 10 * 365 * 86_400

export const PLUGIN_KV_CLEANUP_JOB = 'core:plugin-kv-cleanup'

function checkKey(key: unknown): string {
  if (typeof key !== 'string' || !isStorageKey(key, 255))
    throw new PluginCallRejected('KV 的键长度必须在 1 到 255 个字符之间，首尾不能有空白，不能有 NUL 或不成对的代理项')
  return key
}

/** `ctx.kv`：按插件隔离，值是 JSON；过期的值读出来当作不存在，由定时任务清理 */
export function createPluginKv(db: Kysely<CoreDatabase>, now: () => Date) {
  return {
    async get(pluginId: string, key: unknown): Promise<Json | null> {
      const row = await db
        .selectFrom('plugin_kv')
        .select(['value', 'expires_at'])
        .where('plugin_id', '=', pluginId)
        .where('key', '=', checkKey(key))
        .executeTakeFirst()
      if (!row || (row.expires_at !== null && Date.parse(row.expires_at) <= now().getTime())) return null
      return JSON.parse(row.value) as Json
    },
    async set(pluginId: string, key: unknown, value: unknown, ttlSec?: unknown): Promise<void> {
      const json = JSON.stringify(value)
      if (json === undefined) throw new PluginCallRejected('KV 的值必须能转成 JSON')
      if (Buffer.byteLength(json, 'utf8') > MAX_KV_VALUE_BYTES)
        throw new PluginCallRejected(`KV 的值序列化后不能超过 ${MAX_KV_VALUE_BYTES} 字节`)
      if (
        ttlSec !== undefined &&
        (typeof ttlSec !== 'number' || !Number.isSafeInteger(ttlSec) || ttlSec < 1 || ttlSec > MAX_TTL_SEC)
      )
        throw new PluginCallRejected('ttlSec 必须是 1 到 315360000 之间的整数')
      const time = now()
      await upsert(db, 'plugin_kv', {
        values: {
          plugin_id: pluginId,
          key: checkKey(key),
          value: json,
          expires_at: ttlSec === undefined ? null : toIsoTimestamp(new Date(time.getTime() + ttlSec * 1000)),
          updated_at: toIsoTimestamp(time),
        },
        conflict: ['plugin_id', 'key'],
        update: ['value', 'expires_at', 'updated_at'],
      })
    },
    async delete(pluginId: string, key: unknown): Promise<void> {
      await db.deleteFrom('plugin_kv').where('plugin_id', '=', pluginId).where('key', '=', checkKey(key)).execute()
    },
    /** 定时任务：删掉已经过期的值 */
    async cleanup(): Promise<void> {
      await db.deleteFrom('plugin_kv').where('expires_at', '<=', toIsoTimestamp(now())).execute()
    },
  }
}

export type PluginKv = ReturnType<typeof createPluginKv>
