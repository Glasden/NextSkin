import { tester } from '../rule-tester.ts'
import rule from './no-dialect-specific-sql.ts'

const uniqueMethods = [
  ['onConflict', 'conflict'],
  ['onDuplicateKeyUpdate', 'upsert'],
  ['orIgnore', 'orIgnore'],
  ['orReplace', 'replace'],
  ['orAbort', 'sqliteConflict'],
  ['orFail', 'sqliteConflict'],
  ['orRollback', 'sqliteConflict'],
  ['returningAll', 'returningAll'],
  ['replaceInto', 'replace'],
  ['mergeInto', 'merge'],
  ['distinctOn', 'distinctOn'],
  ['autoIncrement', 'autoIncrement'],
  ['generatedByDefaultAsIdentity', 'autoIncrement'],
  ['generatedAlwaysAsIdentity', 'autoIncrement'],
  ['forUpdate', 'rowLock'],
  ['forShare', 'rowLock'],
  ['forNoKeyUpdate', 'rowLock'],
  ['forKeyShare', 'rowLock'],
] as const

const queryMethods = [
  ['returning', 'returning'],
  ['ignore', 'ignore'],
  ['top', 'top'],
  ['output', 'output'],
  ['skipLocked', 'lockOption'],
  ['noWait', 'lockOption'],
] as const

const queryStarts = ['selectFrom', 'selectNoFrom', 'insertInto', 'updateTable', 'deleteFrom']
const aggregates = ['count', 'countAll', 'countDistinct', 'sum', 'avg']
const names = [...uniqueMethods, ...queryMethods].map(([name]) => name)

tester.run('no-dialect-specific-sql', rule, {
  valid: [
    ...names.flatMap((name) => [
      `x.${name}`,
      `x?.${name}`,
      `const obj = { ${name}: value }`,
      `const obj = { ${name}() {} }`,
      `class Example { ${name}() {} }`,
      `${name}()`,
      // 计算属性调用有意漏报，即使键是静态字符串。
      `x['${name}']()`,
    ]),
    ...queryMethods.flatMap(([name]) => [
      `x.${name}()`,
      `x?.${name}?.()`,
      `x.a().b().${name}()`,
      `db.selectFrom.${name}()`,
      `selectFrom('users').${name}()`,
      `wrapper(db.selectFrom('users')).${name}()`,
      // 不追踪变量或查询参数中的其他查询链。
      `const query = db.selectFrom('users'); query.${name}()`,
      `other.where(db.selectFrom('users')).${name}()`,
      `db['insertInto']('users').${name}()`,
      `db.insertInto('users')['${name}']()`,
    ]),
    'foo.createTable("users")',
    'schema.createTable("users")',
    'db.schema().createTable("users")',
    'db.schema.createTable',
    'db.schema["createTable"]("users")',
    'db["schema"].createTable("users")',
    'db.schema.createTable.call(null, "users")',
    'createTable(db, "users")',
    ...['addColumn', 'modifyColumn'].flatMap((method) => [
      `table.${method}('id', 'integer')`,
      `table.${method}('serial', 'text')`,
      `table.${method}('id', 'serializable')`,
      `table.${method}('id', type)`,
      `table.${method}('id', \`serial\`)`,
      `table.${method}('id')`,
      `${method}('id', 'serial')`,
      `table.${method}`,
    ]),
    ...aggregates.flatMap((name) => [
      `fn.${name}('id')`,
      `eb.fn.${name}('id')`,
      `db.fn.${name}()`,
      `fn?.${name}?.('id')`,
      `other.${name}<number>('id')`,
      `eb.other.${name}<number>('id')`,
      `${name}<number>('id')`,
      `fn['${name}']<number>('id')`,
      `fn.${name}<number>`,
    ]),
    'fn.min<number>("id")',
    'insertReturningId(db, "users", values)',
    'insertOrIgnore(db, "users", values, ["id"])',
    'upsert(db, "users", { values, conflict, update })',
    'countRows(query)',
    'toNumber(value)',
    'autoIncrementId(db)',
    'syncAutoIncrement(db, "users")',
    'sql`returning onConflict ignore schema.createTable serial fn.count<number>() forUpdate`',
    '// db.insertInto("users").returningAll()\nconst value = "onConflict"',
  ],
  invalid: [
    ...uniqueMethods.flatMap(([name, messageId]) =>
      [`x.${name}()`, `x?.${name}()`, `x.${name}?.()`, `x?.${name}?.()`].map((code) => ({
        code,
        errors: [{ messageId }],
      })),
    ),
    ...queryMethods.flatMap(([name, messageId]) =>
      queryStarts.flatMap((start) =>
        [
          `db.${start}('users').${name}()`,
          `db.${start}('users').where('id', '=', 1).${name}()`,
          `db?.${start}?.('users')?.where?.('id', '=', 1)?.${name}?.()`,
        ].map((code) => ({ code, errors: [{ messageId }] })),
      ),
    ),
    {
      code: 'db.replaceInto("users").returning("id")',
      errors: [{ messageId: 'returning' }, { messageId: 'replace' }],
    },
    {
      code: 'db.mergeInto("users").returning("id")',
      errors: [{ messageId: 'returning' }, { messageId: 'merge' }],
    },
    {
      code: '(db?.insertInto("users")).returning("id")',
      errors: [{ messageId: 'returning' }],
    },
    {
      code: '(x?.onConflict)()',
      errors: [{ messageId: 'conflict' }],
    },
    {
      code: 'db.insertInto("users").values(values).onConflict(oc => oc.column("id").doNothing())',
      errors: [{ messageId: 'conflict' }],
    },
    {
      code: 'db.insertInto("users").values(values).onConflict(oc => oc.column("id").doUpdateSet(values))',
      errors: [{ messageId: 'conflict' }],
    },
    ...[
      'db.schema.createTable("users")',
      'trx.schema.createTable("users")',
      'db?.schema?.createTable?.("users")',
      '(db?.schema).createTable("users")',
    ].map((code) => ({ code, errors: [{ messageId: 'createTable' }] })),
    ...['addColumn', 'modifyColumn'].flatMap((method) =>
      ['serial', 'bigserial', 'smallserial', 'SERIAL', 'BigSerial', 'SmallSerial'].flatMap((type) =>
        [`table.${method}('id', '${type}')`, `table?.${method}?.('id', '${type}')`].map((code) => ({
          code,
          errors: [{ messageId: 'serial' }],
        })),
      ),
    ),
    ...aggregates.flatMap((name) =>
      [
        `fn.${name}<number>('id')`,
        `eb.fn.${name}<number>('id')`,
        `db.fn.${name}<bigint>()`,
        `fn?.${name}?.<string | number | bigint>('id')`,
        `db?.fn?.${name}?.<number>('id')`,
        `const { fn } = eb; fn.${name}<number>('id')`,
      ].map((code) => ({ code, errors: [{ messageId: 'aggregateType' }] })),
    ),
  ],
})
