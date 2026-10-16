import { tester } from '../rule-tester.ts'
import rule from './no-sqlite-dialect.ts'

tester.run('no-sqlite-dialect', rule, {
  valid: [
    'import { Kysely, PostgresDialect } from "kysely"',
    'import { SqliteDialect } from "@nextskin/db"',
    'export { SqliteDialect } from "@nextskin/db"',
    'import { NodeSqliteDialect } from "unrelated"',
    'import { createAdapter } from "better-auth/adapters/kysely"',
    'import { createAdapter } from "@better-auth/kysely-adapter"',
    'import type { Database } from "@nextskin/db"',
    'export { Kysely as SqliteDialect } from "kysely"',
  ],
  invalid: [
    ...[
      'import { SqliteDialect } from "kysely"',
      'import { SqliteDialect as UnsafeDialect } from "kysely"',
      'import { "SqliteDialect" as UnsafeDialect } from "kysely"',
      'import type { SqliteDialect } from "kysely"',
      'export { SqliteDialect } from "kysely"',
      'export { SqliteDialect as UnsafeDialect } from "kysely"',
      'export { "SqliteDialect" as UnsafeDialect } from "kysely"',
      'export type { SqliteDialect } from "kysely"',
      'import Dialect from "@better-auth/kysely-adapter/node-sqlite-dialect"',
      'import * as dialect from "@better-auth/kysely-adapter/node-sqlite-dialect"',
      'import "@better-auth/kysely-adapter/node-sqlite-dialect"',
      'export * from "@better-auth/kysely-adapter/node-sqlite-dialect"',
      'export { create } from "@better-auth/kysely-adapter/node-sqlite-dialect"',
      'import { NodeSqliteDialect } from "better-auth"',
      'import { NodeSqliteDialect as UnsafeDialect } from "better-auth/adapters/kysely"',
      'import { NodeSqliteDialect as UnsafeDialect } from "@better-auth/kysely-adapter"',
      'import { "NodeSqliteDialect" as UnsafeDialect } from "@better-auth/kysely-adapter"',
      'import NodeSqliteDialect from "@better-auth/kysely-adapter"',
      'import { other as NodeSqliteDialect } from "better-auth/adapter"',
      'import * as NodeSqliteDialect from "better-auth/adapter"',
    ].map((code) => ({ code, errors: [{ messageId: 'forbidden' }] })),
  ],
})
