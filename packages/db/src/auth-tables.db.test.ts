import { sql, type Insertable, type Kysely } from 'kysely'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import {
  coreMigrations,
  dialectOf,
  insertReturningId,
  migrateToLatest,
  readAuthBoolean,
  readAuthDate,
  toIsoTimestamp,
  writeAuthDate,
  type CoreDatabase,
} from './index.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

const timestamp = toIsoTimestamp(new Date('2040-02-29T23:59:59.123Z'))
// 从逐表规格固定下来的列顺序、必填列及转换字段；不读取迁移实现作为期望值。
const columns = {
  sessions: {
    all: ['id', 'expires_at', 'token', 'created_at', 'updated_at', 'ip_address', 'user_agent', 'user_id'],
    required: ['id', 'expires_at', 'token', 'created_at', 'updated_at', 'user_id'],
    dates: ['expires_at', 'created_at', 'updated_at'],
    booleans: [],
    json: [],
  },
  accounts: {
    all: [
      'id',
      'account_id',
      'provider_id',
      'user_id',
      'access_token',
      'refresh_token',
      'id_token',
      'access_token_expires_at',
      'refresh_token_expires_at',
      'scope',
      'password',
      'created_at',
      'updated_at',
    ],
    required: ['id', 'account_id', 'provider_id', 'user_id', 'created_at', 'updated_at'],
    dates: ['access_token_expires_at', 'refresh_token_expires_at', 'created_at', 'updated_at'],
    booleans: [],
    json: [],
  },
  verifications: {
    all: ['id', 'identifier', 'value', 'expires_at', 'created_at', 'updated_at'],
    required: ['id', 'identifier', 'value', 'expires_at', 'created_at', 'updated_at'],
    dates: ['expires_at', 'created_at', 'updated_at'],
    booleans: [],
    json: [],
  },
  jwks: {
    all: ['id', 'public_key', 'private_key', 'created_at', 'expires_at', 'alg', 'crv'],
    required: ['id', 'public_key', 'private_key', 'created_at'],
    dates: ['created_at', 'expires_at'],
    booleans: [],
    json: [],
  },
  oauth_clients: {
    all: [
      'id',
      'client_id',
      'client_secret',
      'client_discovery_id',
      'disabled',
      'skip_consent',
      'enable_end_session',
      'subject_type',
      'scopes',
      'client_credentials_scopes',
      'user_id',
      'created_at',
      'updated_at',
      'name',
      'uri',
      'icon',
      'contacts',
      'tos',
      'policy',
      'software_id',
      'software_version',
      'software_statement',
      'redirect_uris',
      'post_logout_redirect_uris',
      'backchannel_logout_uri',
      'backchannel_logout_session_required',
      'token_endpoint_auth_method',
      'application_type',
      'jwks',
      'jwks_uri',
      'grant_types',
      'response_types',
      'require_pkce',
      'dpop_bound_access_tokens',
      'reference_id',
      'metadata',
    ],
    required: ['id', 'client_id', 'redirect_uris'],
    dates: ['created_at', 'updated_at'],
    booleans: [
      'disabled',
      'skip_consent',
      'enable_end_session',
      'backchannel_logout_session_required',
      'require_pkce',
      'dpop_bound_access_tokens',
    ],
    json: [
      'scopes',
      'client_credentials_scopes',
      'contacts',
      'redirect_uris',
      'post_logout_redirect_uris',
      'grant_types',
      'response_types',
      'metadata',
    ],
  },
  oauth_resources: {
    all: [
      'id',
      'identifier',
      'name',
      'access_token_ttl',
      'refresh_token_ttl',
      'signing_algorithm',
      'signing_key_id',
      'allowed_scopes',
      'custom_claims',
      'dpop_bound_access_tokens_required',
      'disabled',
      'created_at',
      'updated_at',
      'policy_version',
      'metadata',
    ],
    required: ['id', 'identifier', 'name'],
    dates: ['created_at', 'updated_at'],
    booleans: ['dpop_bound_access_tokens_required', 'disabled'],
    json: ['allowed_scopes', 'custom_claims', 'metadata'],
  },
  oauth_client_resources: {
    all: ['id', 'client_id', 'resource_id', 'metadata', 'created_at'],
    required: ['id', 'client_id', 'resource_id'],
    dates: ['created_at'],
    booleans: [],
    json: ['metadata'],
  },
  oauth_refresh_tokens: {
    all: [
      'id',
      'token',
      'client_id',
      'session_id',
      'user_id',
      'reference_id',
      'authorization_code_id',
      'resources',
      'requested_user_info_claims',
      'expires_at',
      'created_at',
      'revoked',
      'rotated_at',
      'rotation_replay_response',
      'rotation_replay_expires_at',
      'auth_time',
      'confirmation',
      'scopes',
    ],
    required: ['id', 'token', 'client_id', 'user_id', 'expires_at', 'created_at', 'scopes'],
    dates: ['expires_at', 'created_at', 'revoked', 'rotated_at', 'rotation_replay_expires_at', 'auth_time'],
    booleans: [],
    json: ['resources', 'requested_user_info_claims', 'confirmation', 'scopes'],
  },
  oauth_access_tokens: {
    all: [
      'id',
      'token',
      'client_id',
      'session_id',
      'user_id',
      'reference_id',
      'authorization_code_id',
      'resources',
      'requested_user_info_claims',
      'refresh_id',
      'expires_at',
      'created_at',
      'revoked',
      'confirmation',
      'scopes',
    ],
    required: ['id', 'token', 'client_id', 'expires_at', 'created_at', 'scopes'],
    dates: ['expires_at', 'created_at', 'revoked'],
    booleans: [],
    json: ['resources', 'requested_user_info_claims', 'confirmation', 'scopes'],
  },
  oauth_consents: {
    all: [
      'id',
      'client_id',
      'user_id',
      'reference_id',
      'resources',
      'requested_user_info_claims',
      'scopes',
      'created_at',
      'updated_at',
    ],
    required: ['id', 'client_id', 'scopes', 'created_at', 'updated_at'],
    dates: ['created_at', 'updated_at'],
    booleans: [],
    json: ['resources', 'requested_user_info_claims', 'scopes'],
  },
  oauth_client_assertions: {
    all: ['id', 'expires_at'],
    required: ['id', 'expires_at'],
    dates: ['expires_at'],
    booleans: [],
    json: [],
  },
  device_codes: {
    all: [
      'id',
      'device_code',
      'user_code',
      'user_id',
      'expires_at',
      'status',
      'last_polled_at',
      'polling_interval',
      'client_id',
      'scope',
      'resources',
      'oauth_client_id',
    ],
    required: ['id', 'device_code', 'user_code', 'expires_at', 'status'],
    dates: ['expires_at', 'last_polled_at'],
    booleans: [],
    json: ['resources'],
  },
  two_factors: {
    all: ['id', 'secret', 'backup_codes', 'user_id', 'verified', 'failed_verification_count', 'locked_until'],
    required: ['id', 'secret', 'backup_codes', 'user_id'],
    dates: ['locked_until'],
    booleans: ['verified'],
    json: [],
  },
  passkeys: {
    all: [
      'id',
      'name',
      'public_key',
      'user_id',
      'credential_id',
      'counter',
      'device_type',
      'backed_up',
      'transports',
      'created_at',
      'aaguid',
    ],
    required: ['id', 'public_key', 'user_id', 'credential_id', 'counter', 'device_type', 'backed_up'],
    dates: ['created_at'],
    booleans: ['backed_up'],
    json: [],
  },
  device_code_selections: {
    all: ['device_code', 'user_id', 'player_id', 'created_at'],
    required: ['device_code', 'user_id', 'player_id', 'created_at'],
    dates: [],
    booleans: [],
    json: [],
  },
} satisfies Record<string, { all: string[]; required: string[]; dates: string[]; booleans: string[]; json: string[] }>

type AuthTable = keyof typeof columns
type SerialTable = Exclude<AuthTable, 'device_code_selections'>
const tables = Object.keys(columns) as AuthTable[]
let database: TestDatabase<CoreDatabase>
let db: Kysely<CoreDatabase>
let userId: number
let playerId: number
let ids: Partial<Record<SerialTable, number>>

function fixtures(full: boolean) {
  const date = writeAuthDate(db, timestamp)
  return {
    sessions: {
      expires_at: date,
      token: 'token-value',
      created_at: date,
      updated_at: date,
      user_id: userId,
      ...(full
        ? {
            ip_address: 'ip_address-value',
            user_agent: 'user_agent-value',
          }
        : {}),
    },
    accounts: {
      account_id: 'account_id-value',
      provider_id: 'provider_id-value',
      user_id: userId,
      created_at: date,
      updated_at: date,
      ...(full
        ? {
            access_token: 'access_token-value',
            refresh_token: 'refresh_token-value',
            id_token: 'id_token-value',
            access_token_expires_at: date,
            refresh_token_expires_at: date,
            scope: 'scope-value',
            password: 'password-value',
          }
        : {}),
    },
    verifications: {
      identifier: 'identifier-value',
      value: 'value-value',
      expires_at: date,
      created_at: date,
      updated_at: date,
    },
    jwks: {
      public_key: 'public_key-value',
      private_key: 'private_key-value',
      created_at: date,
      ...(full
        ? {
            expires_at: date,
            alg: 'alg-value',
            crv: 'crv-value',
          }
        : {}),
    },
    oauth_clients: {
      client_id: 'client',
      redirect_uris: JSON.stringify(['openid', '汉字']),
      ...(full
        ? {
            client_secret: 'client_secret-value',
            client_discovery_id: 'client_discovery_id-value',
            disabled: true,
            skip_consent: true,
            enable_end_session: true,
            subject_type: 'subject_type-value',
            scopes: JSON.stringify(['openid', '汉字']),
            client_credentials_scopes: JSON.stringify(['openid', '汉字']),
            user_id: userId,
            created_at: date,
            updated_at: date,
            name: 'name-value',
            uri: 'uri-value',
            icon: 'icon-value',
            contacts: JSON.stringify(['openid', '汉字']),
            tos: 'tos-value',
            policy: 'policy-value',
            software_id: 'software_id-value',
            software_version: 'software_version-value',
            software_statement: 'software_statement-value',
            post_logout_redirect_uris: JSON.stringify(['openid', '汉字']),
            backchannel_logout_uri: 'backchannel_logout_uri-value',
            backchannel_logout_session_required: true,
            token_endpoint_auth_method: 'token_endpoint_auth_method-value',
            application_type: 'application_type-value',
            jwks: 'jwks-value',
            jwks_uri: 'jwks_uri-value',
            grant_types: JSON.stringify(['openid', '汉字']),
            response_types: JSON.stringify(['openid', '汉字']),
            require_pkce: true,
            dpop_bound_access_tokens: true,
            reference_id: 'reference_id-value',
            metadata: JSON.stringify({ nested: ['汉字', 1, true, null] }),
          }
        : {}),
    },
    oauth_resources: {
      identifier: 'resource',
      name: 'name-value',
      ...(full
        ? {
            access_token_ttl: 1,
            refresh_token_ttl: 1,
            signing_algorithm: 'signing_algorithm-value',
            signing_key_id: 'signing_key_id-value',
            allowed_scopes: JSON.stringify(['openid', '汉字']),
            custom_claims: JSON.stringify({ nested: ['汉字', 1, true, null] }),
            dpop_bound_access_tokens_required: true,
            disabled: true,
            created_at: date,
            updated_at: date,
            policy_version: 1,
            metadata: JSON.stringify({ nested: ['汉字', 1, true, null] }),
          }
        : {}),
    },
    oauth_client_resources: {
      client_id: 'client',
      resource_id: 'resource',
      ...(full
        ? {
            metadata: JSON.stringify({ nested: ['汉字', 1, true, null] }),
            created_at: date,
          }
        : {}),
    },
    oauth_refresh_tokens: {
      token: 'token-value',
      client_id: 'client',
      user_id: userId,
      expires_at: date,
      created_at: date,
      scopes: JSON.stringify(['openid', '汉字']),
      ...(full
        ? {
            session_id: ids.sessions!,
            reference_id: 'reference_id-value',
            authorization_code_id: 'authorization_code_id-value',
            resources: JSON.stringify(['openid', '汉字']),
            requested_user_info_claims: JSON.stringify(['openid', '汉字']),
            revoked: date,
            rotated_at: date,
            rotation_replay_response: 'rotation_replay_response-value',
            rotation_replay_expires_at: date,
            auth_time: date,
            confirmation: JSON.stringify({ nested: ['汉字', 1, true, null] }),
          }
        : {}),
    },
    oauth_access_tokens: {
      token: 'token-value',
      client_id: 'client',
      expires_at: date,
      created_at: date,
      scopes: JSON.stringify(['openid', '汉字']),
      ...(full
        ? {
            session_id: ids.sessions!,
            user_id: userId,
            reference_id: 'reference_id-value',
            authorization_code_id: 'authorization_code_id-value',
            resources: JSON.stringify(['openid', '汉字']),
            requested_user_info_claims: JSON.stringify(['openid', '汉字']),
            refresh_id: ids.oauth_refresh_tokens!,
            revoked: date,
            confirmation: JSON.stringify({ nested: ['汉字', 1, true, null] }),
          }
        : {}),
    },
    oauth_consents: {
      client_id: 'client',
      scopes: JSON.stringify(['openid', '汉字']),
      created_at: date,
      updated_at: date,
      ...(full
        ? {
            user_id: userId,
            reference_id: 'reference_id-value',
            resources: JSON.stringify(['openid', '汉字']),
            requested_user_info_claims: JSON.stringify(['openid', '汉字']),
          }
        : {}),
    },
    oauth_client_assertions: {
      expires_at: date,
    },
    device_codes: {
      device_code: 'device_code-value',
      user_code: 'user_code-value',
      expires_at: date,
      status: 'status-value',
      ...(full
        ? {
            user_id: 'user_id-value',
            last_polled_at: date,
            polling_interval: 1,
            client_id: 'client',
            scope: 'scope-value',
            resources: JSON.stringify(['openid', '汉字']),
            oauth_client_id: 'oauth_client_id-value',
          }
        : {}),
    },
    two_factors: {
      secret: 'secret-value',
      backup_codes: 'backup_codes-value',
      user_id: userId,
      ...(full
        ? {
            verified: true,
            failed_verification_count: 1,
            locked_until: date,
          }
        : {}),
    },
    passkeys: {
      public_key: 'public_key-value',
      user_id: userId,
      credential_id: 'c'.repeat(1364),
      counter: 1,
      device_type: 'device_type-value',
      backed_up: true,
      ...(full
        ? {
            name: 'name-value',
            transports: 'transports-value',
            created_at: date,
            aaguid: 'aaguid-value',
          }
        : {}),
    },
    device_code_selections: { device_code: 'selection', user_id: userId, player_id: playerId, created_at: timestamp },
  } satisfies { [T in AuthTable]: Insertable<CoreDatabase[T]> }
}

beforeAll(async () => {
  database = await createTestDatabase<CoreDatabase>()
  db = database.db
  await migrateToLatest(db, coreMigrations)
})
afterAll(async () => database?.cleanup())
beforeEach(async () => {
  for (const table of [...tables].reverse()) await db.deleteFrom(table).execute()
  await db.deleteFrom('players').execute()
  await db.deleteFrom('users').execute()
  ids = {}
  userId = await insertReturningId(db, 'users', {
    nickname: '认证测试',
    email: 'auth@example.test',
    email_verified: false,
    created_at: writeAuthDate(db, timestamp),
    updated_at: writeAuthDate(db, timestamp),
  })
  playerId = await insertReturningId(db, 'players', {
    user_id: userId,
    name: 'Alice',
    name_key: 'alice',
    uuid: 'a'.repeat(32),
    created_at: timestamp,
    updated_at: timestamp,
  })
})

async function seed(full = true) {
  for (const table of tables) {
    if (table === 'device_code_selections') {
      await db.insertInto(table).values(fixtures(full)[table]).execute()
    } else {
      ids[table] = await insertReturningId(db, table, fixtures(full)[table])
    }
  }
}

function normalize(table: AuthTable, row: object): Record<string, unknown> {
  const value: Record<string, unknown> = { ...row }
  for (const column of columns[table].dates) if (value[column] != null) value[column] = readAuthDate(value[column])
  for (const column of columns[table].booleans)
    if (value[column] != null) value[column] = readAuthBoolean(value[column])
  for (const column of columns[table].json)
    if (typeof value[column] === 'string') value[column] = JSON.parse(value[column])
  return value
}

test.each([false, true])('十五张表插入并读回：填充可空列 = %s', async (full) => {
  await seed(full)
  for (const table of tables) {
    const expected: Record<string, unknown> = Object.fromEntries(columns[table].all.map((column) => [column, null]))
    if (table !== 'device_code_selections') expected.id = ids[table]
    Object.assign(expected, fixtures(full)[table])
    const rows = await db.selectFrom(table).selectAll().execute()
    expect(rows, table).toHaveLength(1)
    expect(normalize(table, rows[0]!), table).toEqual(normalize(table, expected))
    if (table !== 'device_code_selections') expect(ids[table], table).toBeGreaterThan(0)
  }
})

test('列名、列顺序、可空性和无默认值与规格一致', async () => {
  const metadata = await db.introspection.getTables()
  // MariaDB 将隐式 DEFAULT NULL 报为字符串 "NULL"，Kysely 会误判为有默认值。
  // 读取系统目录排除这一个隐式值，再与其他库使用同一组断言。
  const mysqlDefaults =
    dialectOf(db) === 'mysql'
      ? (
          await sql<{ table_name: string; column_name: string }>`
        select table_name as table_name, column_name as column_name from information_schema.columns
        where table_schema = database() and column_default is not null and column_default <> 'NULL'
      `.execute(db)
        ).rows
      : undefined
  for (const table of tables) {
    const actual = metadata.find((entry) => entry.name === table)!.columns
    expect(
      actual.map((column) => column.name),
      table,
    ).toEqual(columns[table].all)
    // SQLite 的 PRAGMA 对 INTEGER PRIMARY KEY 报 notnull=0，但它实际生成非空自增 ID。
    expect(
      actual.filter((column) => !column.isNullable || column.isAutoIncrementing).map((column) => column.name),
      table,
    ).toEqual(columns[table].required)
    // 自增主键的 sequence 是 PG 的实现细节，其他列都不得有数据库默认值。
    expect(
      actual.filter(
        (column) =>
          column.name !== 'id' &&
          (mysqlDefaults
            ? mysqlDefaults.some((entry) => entry.table_name === table && entry.column_name === column.name)
            : column.hasDefaultValue),
      ),
      table,
    ).toEqual([])
  }
})

test.each([
  ['sessions', 'token'],
  ['oauth_clients', 'client_id'],
  ['oauth_access_tokens', 'token'],
  ['oauth_refresh_tokens', 'token'],
  ['oauth_resources', 'identifier'],
  ['device_codes', 'device_code'],
  ['device_codes', 'user_code'],
] as const)('%s.%s 的唯一索引拒绝重复', async (table, column) => {
  await seed()
  // 先复制完整行，并修改其余唯一列，保证失败只可能来自目标唯一索引。
  const row = { ...fixtures(true)[table] } as Record<string, unknown>
  if (table === 'device_codes') row[column === 'device_code' ? 'user_code' : 'device_code'] = 'another'
  await expect(
    db
      .insertInto(table)
      .values(row as Insertable<CoreDatabase[typeof table]>)
      .execute(),
  ).rejects.toThrow()
})

test('客户端资源的组合唯一索引只约束整个组合', async () => {
  await seed()
  const row = fixtures(true).oauth_client_resources
  await expect(db.insertInto('oauth_client_resources').values(row).execute()).rejects.toThrow()
  await db.insertInto('oauth_clients').values({ client_id: 'other-client', redirect_uris: '[]' }).execute()
  await db.insertInto('oauth_resources').values({ identifier: 'other-resource', name: 'Other' }).execute()
  await db
    .insertInto('oauth_client_resources')
    .values([
      { ...row, client_id: 'other-client' },
      { ...row, resource_id: 'other-resource' },
    ])
    .execute()
  expect(await db.selectFrom('oauth_client_resources').selectAll().execute()).toHaveLength(3)
})

test('设备流选择主键拒绝重复和 NULL', async () => {
  await seed()
  const row = fixtures(true).device_code_selections
  await expect(db.insertInto('device_code_selections').values(row).execute()).rejects.toThrow()
  await expect(
    db
      .insertInto('device_code_selections')
      .values({ ...row, device_code: sql<string>`null` })
      .execute(),
  ).rejects.toThrow()
})

test('删除用户级联删除它的认证数据', async () => {
  await seed()
  await db.deleteFrom('users').where('id', '=', userId).execute()
  for (const table of [
    'sessions',
    'accounts',
    'two_factors',
    'passkeys',
    'oauth_consents',
    'oauth_access_tokens',
    'oauth_refresh_tokens',
    'oauth_clients',
    'device_code_selections',
  ] as const)
    expect(await db.selectFrom(table).selectAll().execute(), table).toEqual([])
})

test('删除用户直接级联令牌和 consent，即使客户端属于其他用户', async () => {
  await seed()
  await db.updateTable('oauth_clients').set({ user_id: null }).execute()
  await db.updateTable('oauth_access_tokens').set({ refresh_id: null }).execute()
  await db.deleteFrom('users').where('id', '=', userId).execute()
  for (const table of ['oauth_consents', 'oauth_access_tokens', 'oauth_refresh_tokens'] as const)
    expect(await db.selectFrom(table).selectAll().execute(), table).toEqual([])
  expect(await db.selectFrom('oauth_clients').selectAll().execute()).toHaveLength(1)
})

test('删除 session 将两种令牌的 session_id 置空并保留令牌', async () => {
  await seed()
  await db.deleteFrom('sessions').execute()
  for (const table of ['oauth_access_tokens', 'oauth_refresh_tokens'] as const) {
    const rows = await db.selectFrom(table).select('session_id').execute()
    expect(rows, table).toEqual([{ session_id: null }])
  }
})

test('删除 refresh token 级联删除引用它的 access token', async () => {
  await seed()
  await db.deleteFrom('oauth_refresh_tokens').execute()
  expect(await db.selectFrom('oauth_access_tokens').selectAll().execute()).toEqual([])
})

test('删除 oauth client 级联删除它的令牌、consent 和资源关联', async () => {
  await seed()
  // 分别验证 access token 自身的客户端外键，避免 refresh token 的级联路径掩盖错误。
  await db.updateTable('oauth_access_tokens').set({ refresh_id: null }).execute()
  await db.deleteFrom('oauth_clients').execute()
  for (const table of [
    'oauth_access_tokens',
    'oauth_refresh_tokens',
    'oauth_consents',
    'oauth_client_resources',
  ] as const)
    expect(await db.selectFrom(table).selectAll().execute(), table).toEqual([])
  expect(await db.selectFrom('users').selectAll().execute()).toHaveLength(1)
})

test('删除 oauth resource 级联删除资源关联', async () => {
  await seed()
  await db.deleteFrom('oauth_resources').execute()
  expect(await db.selectFrom('oauth_client_resources').selectAll().execute()).toEqual([])
})

test('删除角色级联删除设备流选择，保留用户', async () => {
  await seed()
  await db.deleteFrom('players').execute()
  expect(await db.selectFrom('device_code_selections').selectAll().execute()).toEqual([])
  expect(await db.selectFrom('users').selectAll().execute()).toHaveLength(1)
})

test('选择的角色属于另一用户时，删除认领者仍直接级联删除设备流选择', async () => {
  await seed()
  const ownerId = await insertReturningId(db, 'users', {
    nickname: '角色所有者',
    email: 'owner@example.test',
    email_verified: false,
    created_at: writeAuthDate(db, timestamp),
    updated_at: writeAuthDate(db, timestamp),
  })
  await db.updateTable('players').set({ user_id: ownerId }).execute()
  await db.deleteFrom('users').where('id', '=', userId).execute()
  expect(await db.selectFrom('device_code_selections').selectAll().execute()).toEqual([])
  expect(await db.selectFrom('players').selectAll().execute()).toHaveLength(1)
})

test('客户端标识区分大小写，字符串外键也按原大小写匹配', async () => {
  await db
    .insertInto('oauth_clients')
    .values([
      { client_id: 'abc', redirect_uris: '[]' },
      { client_id: 'ABC', redirect_uris: '[]' },
    ])
    .execute()
  const rows = await db.selectFrom('oauth_clients').select('client_id').execute()
  expect(rows.map((row) => row.client_id).sort()).toEqual(['ABC', 'abc'])
  await expect(
    db
      .insertInto('oauth_consents')
      .values({
        client_id: 'Abc',
        scopes: '[]',
        created_at: writeAuthDate(db, timestamp),
        updated_at: writeAuthDate(db, timestamp),
      })
      .execute(),
  ).rejects.toThrow()
})

test('passkeys.credential_id 能存 WebAuthn 允许的最长 ID（1364 个 base64url 字符），并区分大小写', async () => {
  await seed()
  expect((await db.selectFrom('passkeys').select('credential_id').executeTakeFirstOrThrow()).credential_id).toBe(
    'c'.repeat(1364),
  )
  expect(await db.selectFrom('passkeys').select('id').where('credential_id', '=', 'C'.repeat(1364)).execute()).toEqual(
    [],
  )
})

const foreignKeys = [
  ['sessions', 'user_id'],
  ['accounts', 'user_id'],
  ['oauth_clients', 'user_id'],
  ['oauth_client_resources', 'client_id'],
  ['oauth_client_resources', 'resource_id'],
  ['oauth_refresh_tokens', 'client_id'],
  ['oauth_refresh_tokens', 'session_id'],
  ['oauth_refresh_tokens', 'user_id'],
  ['oauth_access_tokens', 'client_id'],
  ['oauth_access_tokens', 'session_id'],
  ['oauth_access_tokens', 'user_id'],
  ['oauth_access_tokens', 'refresh_id'],
  ['oauth_consents', 'client_id'],
  ['oauth_consents', 'user_id'],
  ['two_factors', 'user_id'],
  ['passkeys', 'user_id'],
  ['device_code_selections', 'user_id'],
  ['device_code_selections', 'player_id'],
] as const

test.each(foreignKeys)('%s.%s 的外键拒绝悬空引用', async (table, column) => {
  await seed()
  const missing = column === 'client_id' || column === 'resource_id' ? 'missing' : 2147483647
  await expect(sql`update ${sql.table(table)} set ${sql.ref(column)} = ${missing}`.execute(db)).rejects.toThrow()
})

test('所有外键列都有以该列开头的索引，Better Auth 索引名符合规格', async () => {
  // Kysely introspection 不提供索引；系统目录按方言查询，归一化后使用同一组断言。
  type Index = { table_name: string; index_name: string; column_name: string }
  let indexes: Index[]
  if (dialectOf(db) === 'sqlite') {
    indexes = (
      await sql<Index>`
      select m.name as table_name, i.name as index_name, p.name as column_name
      from sqlite_master m
      join pragma_index_list(m.name) i
      join pragma_index_info(i.name) p
      where m.type = 'table' and p.seqno = 0
    `.execute(db)
    ).rows
  } else if (dialectOf(db) === 'mysql') {
    indexes = (
      await sql<Index>`
      select table_name as table_name, index_name as index_name, column_name as column_name from information_schema.statistics
      where table_schema = database() and seq_in_index = 1
    `.execute(db)
    ).rows
  } else {
    indexes = (
      await sql<Index>`
      select t.relname as table_name, i.relname as index_name, a.attname as column_name
      from pg_index x
      join pg_class t on t.oid = x.indrelid
      join pg_namespace n on n.oid = t.relnamespace
      join pg_class i on i.oid = x.indexrelid
      join pg_attribute a on a.attrelid = t.oid and a.attnum = x.indkey[0]
      where n.nspname = current_schema()
    `.execute(db)
    ).rows
  }
  for (const [table, column] of foreignKeys) {
    expect(
      indexes.some((index) => index.table_name === table && index.column_name === column),
      `${table}.${column}`,
    ).toBe(true)
  }
  const expected = {
    sessions: ['token_uidx', 'user_id_idx'],
    accounts: ['user_id_idx'],
    verifications: ['identifier_idx'],
    oauth_clients: ['client_id_uidx', 'user_id_idx'],
    oauth_resources: ['identifier_uidx'],
    oauth_client_resources: ['client_id_idx', 'resource_id_idx', 'client_id_resource_id_uidx'],
    oauth_refresh_tokens: ['token_uidx', 'client_id_idx', 'session_id_idx', 'user_id_idx', 'authorization_code_id_idx'],
    oauth_access_tokens: [
      'token_uidx',
      'client_id_idx',
      'session_id_idx',
      'user_id_idx',
      'authorization_code_id_idx',
      'refresh_id_idx',
    ],
    oauth_consents: ['client_id_idx', 'user_id_idx'],
    device_codes: ['device_code_uidx', 'user_code_uidx'],
    two_factors: ['secret_idx', 'user_id_idx'],
    passkeys: ['user_id_idx', 'credential_id_idx'],
    device_code_selections: ['user_id_index', 'player_id_index'],
  }
  for (const [table, suffixes] of Object.entries(expected)) {
    expect(indexes.filter((index) => index.table_name === table).map((index) => index.index_name)).toEqual(
      expect.arrayContaining(suffixes.map((suffix) => `${table}_${suffix}`)),
    )
  }
})
