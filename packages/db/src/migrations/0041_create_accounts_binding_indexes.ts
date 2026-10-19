import type { Kysely } from 'kysely'

/**
 * 一个第三方账号只绑一个用户；一个用户在每个 Provider 上只绑一个第三方账号（ADR-0034）。
 * `credential` 每个用户本来就只有一行，`account_id` 是 uid，两个索引对它也成立
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createIndex('accounts_provider_id_account_id_uidx')
    .on('accounts')
    .columns(['provider_id', 'account_id'])
    .unique()
    .execute()
  await db.schema
    .createIndex('accounts_user_id_provider_id_uidx')
    .on('accounts')
    .columns(['user_id', 'provider_id'])
    .unique()
    .execute()
}
