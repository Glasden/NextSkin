import { countRows } from '@nextskin/db'
import type { Kysely } from 'kysely'

/** 旧库的表名和列名都由运行时决定（表前缀、插件的表），只能按字符串访问 */
export type SourceDatabase = Record<string, Record<string, unknown>>

/** BS 6.0.2 的迁移建的表，导入要用的列（tests/contract/bs-v6 的实例里核对过） */
const REQUIRED = {
  users: [
    'uid',
    'email',
    'nickname',
    'locale',
    'score',
    'avatar',
    'password',
    'ip',
    'permission',
    'last_sign_at',
    'register_at',
    'verified',
  ],
  players: ['pid', 'uid', 'name', 'tid_skin', 'tid_cape', 'last_modified'],
  textures: ['tid', 'name', 'type', 'hash', 'size', 'uploader', 'public', 'upload_at', 'likes'],
  options: ['option_name', 'option_value'],
  user_closet: ['user_uid', 'texture_tid', 'item_name'],
  reports: ['id', 'tid', 'uploader', 'reporter', 'reason', 'status', 'report_at'],
  oauth_clients: [
    'id',
    'user_id',
    'name',
    'secret',
    'redirect',
    'personal_access_client',
    'password_client',
    'revoked',
    'created_at',
    'updated_at',
  ],
} as const

/** 认得、但不导入的表（docs/schema.md "不导入的数据"） */
const IGNORED = new Set([
  'jobs',
  'failed_jobs',
  'migrations',
  'language_lines',
  'notifications',
  'oauth_access_tokens',
  'oauth_auth_codes',
  'oauth_refresh_tokens',
  'oauth_personal_access_clients',
  'scopes',
  'ygg_log',
  'code_id_to_uuid',
])

export interface SourceSchema {
  /** 带前缀的真实表名 */
  tables: Record<keyof typeof REQUIRED, string>
  /** yggdrasil-api 或 yggdrasil-connect 的 UUID 映射表；hasPid：yggdrasil-connect 的结构，有 pid 列 */
  uuid: { table: string; hasPid: boolean } | null
  /** texture-description 插件的描述：新版是 textures_description.description，旧版是 textures_desc.desc */
  descriptions: { table: string; column: string } | null
  unknown: { name: string; rows: number }[]
}

export class SourceSchemaError extends Error {
  readonly missing: string[]
  constructor(missing: string[]) {
    super(`旧库缺少 BS 6 的表或列：${missing.join('、')}。请确认表前缀，旧站要先升级到 BS 6`)
    this.name = 'SourceSchemaError'
    this.missing = missing
  }
}

export async function inspectSourceSchema(db: Kysely<SourceDatabase>, prefix: string): Promise<SourceSchema> {
  const all = (await db.introspection.getTables()).filter((table) => !table.isView)
  // PostgreSQL 会列出所有 schema 的表；BS 用 public（config/database.php）
  const publicTables = all.filter((table) => table.schema === 'public')
  const tables = new Map(
    (publicTables.length ? publicTables : all)
      .filter((table) => table.name.startsWith(prefix))
      .map((table) => [table.name.slice(prefix.length), new Set(table.columns.map((column) => column.name))]),
  )
  const missing: string[] = []
  for (const [name, columns] of Object.entries(REQUIRED)) {
    const found = tables.get(name)
    if (!found) missing.push(prefix + name)
    else for (const column of columns) if (!found.has(column)) missing.push(`${prefix}${name}.${column}`)
  }
  if (missing.length) throw new SourceSchemaError(missing)

  const uuidColumns = tables.get('uuid')
  const uuid =
    uuidColumns && uuidColumns.has('id') && uuidColumns.has('name') && uuidColumns.has('uuid')
      ? { table: prefix + 'uuid', hasPid: uuidColumns.has('pid') }
      : null
  const descriptions = tables.get('textures_description')?.has('description')
    ? { table: prefix + 'textures_description', column: 'description' }
    : tables.get('textures_desc')?.has('desc')
      ? { table: prefix + 'textures_desc', column: 'desc' }
      : null

  const recognized = new Set<string>([...Object.keys(REQUIRED), ...IGNORED])
  if (uuid) recognized.add('uuid')
  if (descriptions) recognized.add(descriptions.table.slice(prefix.length))
  const unknown: SourceSchema['unknown'] = []
  for (const name of [...tables.keys()].sort()) {
    if (recognized.has(name)) continue
    unknown.push({ name: prefix + name, rows: await countRows(db.selectFrom(prefix + name)) })
  }
  return {
    tables: Object.fromEntries(Object.keys(REQUIRED).map((name) => [name, prefix + name])) as SourceSchema['tables'],
    uuid,
    descriptions,
    unknown,
  }
}
