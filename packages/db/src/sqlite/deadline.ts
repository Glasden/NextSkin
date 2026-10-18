import type { DatabaseSync } from 'node:sqlite'

export const PLUGIN_DEADLINE_ERROR = 'nextskin plugin query deadline exceeded'

export function registerPluginDeadline(db: DatabaseSync): void {
  // 不能标 deterministic，否则 SQLite 可能只求值一次。期限是语句参数，不共享可变状态。
  // 常量参数仍会被移到最外层循环；外层很小而内层很大时不能保证逐行中止。
  db.function('nextskin_deadline', (deadline) => {
    if (typeof deadline !== 'number' || Date.now() >= deadline) throw new Error(PLUGIN_DEADLINE_ERROR)
    return 1
  })
}
