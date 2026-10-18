// 测试用的 BS 旧库：按 BS 6.0.2 的迁移建表，列类型照抄 Laravel 在三种数据库上的映射
// （tests/contract/bs-v6 的实例里用 SHOW CREATE TABLE 核对过 MySQL 上的结果）。
// 这是别人的表结构，方言差异只在这个测试辅助文件里出现
import { createHash } from 'node:crypto'
import { dialectOf } from '@nextskin/db'
import { sql, type Kysely, type RawBuilder } from 'kysely'
import type { SourceDatabase } from '../source/schema.ts'

type Dialect = ReturnType<typeof dialectOf>

function types(dialect: Dialect) {
  const by = (mysql: string, postgres: string, sqlite: string) =>
    sql.raw(dialect === 'mysql' ? mysql : dialect === 'postgres' ? postgres : sqlite)
  return {
    increments: by(
      'int unsigned not null auto_increment primary key',
      'serial primary key',
      'integer primary key autoincrement not null',
    ),
    bigIncrements: by(
      'bigint unsigned not null auto_increment primary key',
      'bigserial primary key',
      'integer primary key autoincrement not null',
    ),
    integer: by('int', 'integer', 'integer'),
    unsignedInteger: by('int unsigned', 'integer', 'integer'),
    unsignedBigInteger: by('bigint unsigned', 'bigint', 'integer'),
    tinyInteger: by('tinyint', 'smallint', 'integer'),
    boolean: by('tinyint(1)', 'boolean', 'tinyint(1)'),
    dateTime: by('datetime', 'timestamp(0) without time zone', 'datetime'),
    timestamp: by('timestamp null', 'timestamp(0) without time zone null', 'datetime null'),
    longText: by('longtext', 'text', 'text'),
    falseValue: by('0', 'false', '0'),
    // BS 的表都是 utf8mb4_unicode_ci：比较角色名、邮箱时忽略大小写
    tableOptions: by('engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci', '', ''),
  }
}

export interface BsSchemaOptions {
  prefix?: string
  /** yggdrasil-api 的 uuid 表只有 name；yggdrasil-connect 的按 pid 关联，三列都唯一 */
  uuidTable?: 'yggdrasil-api' | 'yggdrasil-connect' | 'none'
  /** texture-description 插件：新版 textures_description.description，旧版 textures_desc.desc */
  descriptions?: 'new' | 'old' | 'none'
}

export async function createBsSchema(db: Kysely<SourceDatabase>, options: BsSchemaOptions = {}): Promise<void> {
  const t = types(dialectOf(db))
  const p = options.prefix ?? ''
  const table = (name: string) => sql.table(p + name)
  const create = async (name: string, columns: RawBuilder<unknown>[]) => {
    await sql`create table ${table(name)} (${sql.join(columns)}) ${t.tableOptions}`.execute(db)
  }
  await create('users', [
    sql`uid ${t.increments}`,
    sql`email varchar(100) not null`,
    sql`nickname varchar(50) not null default ''`,
    sql`locale varchar(255) null`,
    sql`score ${t.integer} not null`,
    sql`avatar ${t.integer} not null default 0`,
    sql`password varchar(255) not null`,
    sql`ip varchar(45) not null`,
    sql`is_dark_mode ${t.boolean} not null default ${t.falseValue}`,
    sql`permission ${t.integer} not null default 0`,
    sql`last_sign_at ${t.dateTime} not null`,
    sql`register_at ${t.dateTime} not null`,
    sql`verified ${t.boolean} not null default ${t.falseValue}`,
    sql`verification_token varchar(255) not null default ''`,
    sql`remember_token varchar(100) null`,
  ])
  await create('players', [
    sql`pid ${t.increments}`,
    sql`uid ${t.integer} not null`,
    sql`name varchar(50) not null`,
    sql`tid_cape ${t.integer} not null default 0`,
    sql`last_modified ${t.dateTime} not null`,
    sql`tid_skin ${t.integer} not null default -1`,
  ])
  await create('textures', [
    sql`tid ${t.increments}`,
    sql`name varchar(50) not null`,
    sql`type varchar(10) not null`,
    sql`hash varchar(64) not null`,
    sql`size ${t.integer} not null`,
    sql`uploader ${t.integer} not null`,
    sql`public ${t.tinyInteger} not null`,
    sql`upload_at ${t.dateTime} not null`,
    sql`likes ${t.unsignedInteger} not null default 0`,
  ])
  await create('options', [
    sql`id ${t.increments}`,
    sql`option_name varchar(50) not null`,
    sql`option_value ${t.longText} not null`,
  ])
  await create('user_closet', [
    sql`user_uid ${t.integer} not null`,
    sql`texture_tid ${t.integer} not null`,
    sql`item_name text null`,
  ])
  await create('reports', [
    sql`id ${t.increments}`,
    sql`tid ${t.integer} not null`,
    sql`uploader ${t.integer} not null`,
    sql`reporter ${t.integer} not null`,
    sql`reason ${t.longText} not null`,
    sql`status ${t.integer} not null`,
    sql`report_at ${t.dateTime} not null`,
  ])
  await create('oauth_clients', [
    sql`id ${t.bigIncrements}`,
    sql`user_id ${t.unsignedBigInteger} null`,
    sql`name varchar(255) not null`,
    sql`secret varchar(100) null`,
    sql`provider varchar(255) null`,
    sql`redirect text not null`,
    sql`personal_access_client ${t.boolean} not null`,
    sql`password_client ${t.boolean} not null`,
    sql`revoked ${t.boolean} not null`,
    sql`created_at ${t.timestamp}`,
    sql`updated_at ${t.timestamp}`,
  ])
  await create('migrations', [
    sql`id ${t.increments}`,
    sql`migration varchar(255) not null`,
    sql`batch ${t.integer} not null`,
  ])
  if (options.uuidTable === 'yggdrasil-api')
    await create('uuid', [sql`id ${t.increments}`, sql`name varchar(255) not null`, sql`uuid varchar(255) not null`])
  if (options.uuidTable === 'yggdrasil-connect') {
    // yggc:fix-uuid-table 加的 pid 列可以为空；全新安装的 yggdrasil-connect 建的是非空的
    await create('uuid', [
      sql`id ${t.increments}`,
      sql`pid ${t.unsignedInteger} null unique`,
      sql`name varchar(255) not null unique`,
      sql`uuid varchar(255) not null unique`,
      sql`created_at ${t.timestamp}`,
      sql`updated_at ${t.timestamp}`,
    ])
  }
  if (options.descriptions === 'new')
    await create('textures_description', [
      sql`id ${t.bigIncrements}`,
      sql`tid ${t.unsignedBigInteger} not null unique`,
      sql`description varchar(255) not null`,
    ])
  if (options.descriptions === 'old')
    await create('textures_desc', [
      sql`id ${t.bigIncrements}`,
      sql`tid ${t.unsignedBigInteger} not null`,
      sql`${sql.ref('desc')} varchar(255) not null`,
    ])
}

export async function insertRows(
  db: Kysely<SourceDatabase>,
  table: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  if (rows.length) await db.insertInto(table).values(rows).execute()
}

/** BS 的文件 hash：文件字节的 sha256 */
export function fileHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export async function dropBsSchema(db: Kysely<SourceDatabase>, prefix = ''): Promise<void> {
  for (const name of [
    'textures_description',
    'textures_desc',
    'uuid',
    'migrations',
    'oauth_clients',
    'reports',
    'user_closet',
    'options',
    'textures',
    'players',
    'users',
    'mojang_verifications',
  ])
    await sql`drop table if exists ${sql.table(prefix + name)}`.execute(db)
}
