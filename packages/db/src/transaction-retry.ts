import type { Kysely, Transaction } from 'kysely'

export function isRetryableTransactionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  if ('errno' in error) return error.errno === 1213
  return 'code' in error && (error.code === '40P01' || error.code === '40001')
}

/** 只重试自己开启的整个事务；回调里不得包含网络请求或其他外部副作用。 */
export async function transactionWithRetry<DB, T>(
  db: Kysely<DB>,
  fn: (transaction: Transaction<DB>) => Promise<T>,
  { attempts = 3 }: { attempts?: number } = {},
): Promise<T> {
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new RangeError('attempts must be a positive integer')
  if (db.isTransaction) throw new TypeError('transactionWithRetry must own the transaction')
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction().execute(fn)
    } catch (error) {
      if (attempt >= attempts || !isRetryableTransactionError(error)) throw error
    }
  }
}
