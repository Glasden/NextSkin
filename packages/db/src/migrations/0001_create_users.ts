import { sql, type Kysely } from 'kysely'
import { authBooleanType, authDateType, autoIncrementId, createTable, isoTimestampColumn } from '../helpers.ts'

export async function up(db: Kysely<unknown>): Promise<void> {
  await createTable(db, 'users')
    .$call(autoIncrementId(db))
    .addColumn('nickname', 'varchar(255)', (c) => c.notNull())
    .addColumn('email', 'varchar(255)', (c) => c.notNull())
    .addColumn('email_verified', authBooleanType(db), (c) => c.notNull())
    .addColumn('image', 'text')
    .addColumn('two_factor_enabled', authBooleanType(db))
    .addColumn('created_at', authDateType(db), (c) => c.notNull())
    .addColumn('updated_at', authDateType(db), (c) => c.notNull())
    .addColumn('role', 'varchar(16)', (c) => c.notNull().defaultTo('user'))
    .addColumn('score', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('locale', 'varchar(16)')
    .addColumn('registration_ip', 'varchar(45)')
    .$call(isoTimestampColumn(db, 'last_check_in_at', { nullable: true }))
    .addCheckConstraint('users_role_check', sql`role in ('banned', 'user', 'admin', 'superadmin')`)
    .execute()
  await db.schema.createIndex('users_email_unique').on('users').column('email').unique().execute()
}
