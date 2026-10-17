import type { Kysely } from 'kysely'
import { authBooleanType, authDateType, authStringType, autoIncrementId, createTable } from '../helpers.ts'

export async function up(db: Kysely<unknown>): Promise<void> {
  await createTable(db, 'passkeys')
    .$call(autoIncrementId(db))
    .addColumn('name', 'text')
    .addColumn('public_key', 'text', (c) => c.notNull())
    .addColumn('user_id', 'integer', (c) => c.notNull())
    // WebAuthn 的 credential ID 最长 1023 字节，base64url 编码后 1364 个字符
    .addColumn('credential_id', authStringType(db, 1364, { ascii: true }), (c) => c.notNull())
    // 与 Better Auth 一致用 integer。规范允许到 2^32 - 1，超过 2^31 - 1 的计数器写不进去；
    // 改用 bigint 的话 pg 会读出字符串（ADR-0015），为极少见的认证器不值得
    .addColumn('counter', 'integer', (c) => c.notNull())
    .addColumn('device_type', 'text', (c) => c.notNull())
    .addColumn('backed_up', authBooleanType(db), (c) => c.notNull())
    .addColumn('transports', 'text')
    .addColumn('created_at', authDateType(db))
    .addColumn('aaguid', 'text')
    .addForeignKeyConstraint('passkeys_user_id_fk', ['user_id'], 'users', ['id'], (c) => c.onDelete('cascade'))
    .execute()
  await db.schema.createIndex('passkeys_user_id_idx').on('passkeys').column('user_id').execute()
  await db.schema.createIndex('passkeys_credential_id_idx').on('passkeys').column('credential_id').execute()
}
