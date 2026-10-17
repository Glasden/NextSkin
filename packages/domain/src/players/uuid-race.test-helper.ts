import type { KyselyPlugin, QueryId } from 'kysely'

/**
 * 测试用：让下一次按 uuid 查 players 的查询扑空，模拟离线 UUID 在预查之后才被并发改名的角色占上
 * （createPlayer、retryOnPlayerUuidRace）。在 SQLite 上用并发构造不出这种交错，四种数据库都用它来测
 */
export function missUuidPrecheckOnce(): KyselyPlugin {
  let armed = true
  const missed = new Set<QueryId>()
  return {
    transformQuery({ node, queryId }) {
      const text = JSON.stringify(node)
      if (armed && node.kind === 'SelectQueryNode' && text.includes('"players"') && text.includes('"uuid"')) {
        armed = false
        missed.add(queryId)
      }
      return node
    },
    transformResult({ result, queryId }) {
      return Promise.resolve(missed.has(queryId) ? { ...result, rows: [] } : result)
    },
  }
}
