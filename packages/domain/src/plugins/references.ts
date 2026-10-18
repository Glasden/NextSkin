/**
 * 插件表格里 `user`、`player` 格式的列：值是 id，核心按 id 查出昵称、头像和角色名再渲染（SDK 的 ui.ts）。
 * 只读公开的信息：昵称、头像和角色名本来就在站点上公开
 */
import type { CoreDatabase } from '@nextskin/db'
import type { Kysely } from 'kysely'
import { userSummaries } from '../admin/queries.ts'

/** 一页表格最多 100 行，每行几列 */
const MAX_IDS = 500

export interface PluginReferences {
  users: Record<number, { nickname: string; avatar: { hash: string; scale: number } | null }>
  players: Record<number, { name: string }>
}

function ids(values: readonly unknown[]): number[] {
  const result = new Set<number>()
  for (const value of values) {
    const id = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value
    if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) result.add(id)
    if (result.size >= MAX_IDS) break
  }
  return [...result]
}

export async function pluginReferences(
  db: Kysely<CoreDatabase>,
  input: { uids: readonly unknown[]; pids: readonly unknown[] },
): Promise<PluginReferences> {
  const uids = ids(input.uids)
  const pids = ids(input.pids)
  const [users, players] = await Promise.all([
    userSummaries(db, uids),
    pids.length ? db.selectFrom('players').select(['id', 'name']).where('id', 'in', pids).execute() : [],
  ])
  return {
    users: Object.fromEntries(users.map(({ uid, ...user }) => [uid, user])),
    players: Object.fromEntries(players.map((player) => [player.id, { name: player.name }])),
  }
}
