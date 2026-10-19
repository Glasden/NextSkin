import type { CoreDatabase } from '@nextskin/db'
import type { Kysely, Transaction } from 'kysely'
import { vi } from 'vitest'

/**
 * 让 db 上接下来开始的第一个事务做完业务、停在提交之前，直到 resume。之后开始的事务要排在它后面：
 * PostgreSQL、MySQL 上等它锁住的行，SQLite 上等唯一的连接。contended 在下一个事务开始时兑现
 */
export function pauseNextCommit(db: Kysely<CoreDatabase>) {
  const entered = Promise.withResolvers<void>(),
    contended = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  const transaction = db.transaction.bind(db)
  let armed = true
  const spy = vi.spyOn(db, 'transaction').mockImplementation(() => {
    const builder = transaction(),
      execute = builder.execute.bind(builder)
    builder.execute = <T>(run: (tx: Transaction<CoreDatabase>) => Promise<T>) => {
      if (!armed) contended.resolve()
      return execute(async (tx) => {
        const result = await run(tx)
        if (armed) {
          armed = false
          entered.resolve()
          await release.promise
        }
        return result
      })
    }
    return builder
  })
  return {
    entered: entered.promise,
    contended: contended.promise,
    resume: () => release.resolve(),
    restore: () => spy.mockRestore(),
  }
}
