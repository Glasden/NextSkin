import {
  ColumnNode,
  MysqlAdapter,
  PostgresAdapter,
  SqliteAdapter,
  sql,
  type RawBuilder,
  type SqlBool,
  type CreateTableBuilder,
  type InsertObject,
  type Kysely,
  type SelectQueryBuilder,
  type SelectType,
  type UpdateObject,
  type UpdateQueryBuilder,
  type UpdateResult,
  type Transaction,
  type ExpressionBuilder,
} from 'kysely'

export type DatabaseDialect = 'sqlite' | 'mysql' | 'postgres'

export function dialectOf<DB>(db: Kysely<DB>): DatabaseDialect {
  // Kysely 0.29 没有公开的方言访问接口；将内部 API 依赖限制在此处，由四库测试同时守护事务实例。
  const adapter = db.getExecutor().adapter
  if (adapter instanceof MysqlAdapter) return 'mysql'
  if (adapter instanceof PostgresAdapter) return 'postgres'
  if (adapter instanceof SqliteAdapter) return 'sqlite'
  throw new Error('数据库方言不受支持；请通过 createDatabase 创建 SQLite、MySQL 或 PostgreSQL 连接')
}

export function toNumber(value: string | number | bigint): number {
  if (typeof value === 'string' && !/^-?\d+$/.test(value))
    throw new RangeError('数据库结果不是整数字符串；请确认聚合表达式返回整数')
  const number = Number(value)
  if (!Number.isSafeInteger(number))
    throw new RangeError('数据库结果不是安全整数；请检查聚合结果或使用 bigint 处理超出安全整数范围的值')
  return number
}

type UpdateObjectExpression<DB, TB extends keyof DB, UT extends keyof DB = TB> =
  UpdateObject<DB, TB, UT> | ((eb: ExpressionBuilder<DB, TB>) => UpdateObject<DB, TB, UT>)

type Column<DB, TB extends keyof DB> = keyof DB[TB] & string

type NumericColumn<DB, TB extends keyof DB> = {
  [C in Column<DB, TB>]: SelectType<DB[TB][C]> extends number ? C : never
}[Column<DB, TB>]

export async function insertReturningId<DB, TB extends keyof DB & string>(
  db: Kysely<DB>,
  table: TB,
  values: InsertObject<DB, TB>,
  idColumn: NumericColumn<DB, TB> = 'id' as NumericColumn<DB, TB>,
): Promise<number> {
  const query = db.insertInto(table).values(values)
  if (dialectOf(db) === 'mysql') {
    const { insertId } = await query.executeTakeFirstOrThrow()
    if (insertId === undefined) throw new Error('插入未返回自增 ID；请确认目标列已配置为自增主键')
    return toNumber(insertId)
  }

  const row = await query
    .returning(sql<string | number | bigint>`${sql.ref(idColumn)}`.as('generated_id'))
    .$castTo<{ generated_id: string | number | bigint }>()
    .executeTakeFirstOrThrow()
  return toNumber(row.generated_id)
}

export async function insertOrIgnore<DB, TB extends keyof DB & string>(
  db: Kysely<DB>,
  table: TB,
  values: InsertObject<DB, TB>,
  conflictColumns: readonly Column<DB, TB>[],
): Promise<boolean> {
  if (!conflictColumns.length) throw new Error('insertOrIgnore 缺少冲突列；请在 conflictColumns 中指定至少一列')
  const query = db.insertInto(table).values(values)
  if (dialectOf(db) === 'mysql') {
    // MySQL 上任意唯一键冲突都返回 false，不限于 conflictColumns。
    // INSERT IGNORE 会隐藏数据错误，ON DUPLICATE KEY 的受影响行数又受 FOUND_ROWS 影响。
    try {
      await query.executeTakeFirstOrThrow()
      return true
    } catch (error) {
      if (isMysqlDuplicate(error)) return false
      throw error
    }
  }
  // PostgreSQL 出错会使整个事务失效，必须通过 ON CONFLICT 避免抛出重复键错误。
  const result = await query
    .onConflict((conflict) => conflict.columns([...conflictColumns]).doNothing())
    .executeTakeFirstOrThrow()
  return toNumber(result.numInsertedOrUpdatedRows ?? 0n) > 0
}

/**
 * values 的每一行必须本身就是能单独插入的合法行。
 * MySQL 命中已有行时直接 UPDATE，不会像 PG/SQLite 那样先检查待插入行的 CHECK 等约束。
 */
export async function upsert<DB, TB extends keyof DB & string>(
  db: Kysely<DB> | Transaction<DB>,
  table: TB,
  options: NoInfer<{
    values: InsertObject<DB, TB> | readonly InsertObject<DB, TB>[]
    conflict: readonly Column<DB, TB>[]
    /** 引用已有行时请限定表名，例如 eb.ref('items.n')，避免与 excluded 列产生歧义。 */
    update: readonly Column<DB, TB>[] | UpdateObjectExpression<DB, TB>
  }>,
): Promise<void> {
  if (!options.conflict.length) throw new Error('upsert 缺少冲突列；请在 conflict 中指定至少一列')
  const rows: readonly InsertObject<DB, TB>[] = Array.isArray(options.values)
    ? options.values
    : [options.values as InsertObject<DB, TB>]
  if (Array.isArray(options.update) && !options.update.length) {
    throw new Error('upsert 缺少更新列；请在 update 中指定至少一列')
  }
  if (rows.length > 1 && !Array.isArray(options.update)) {
    throw new Error('多行 upsert 只能使用列名数组更新；请逐行执行需要对象或表达式工厂的更新')
  }
  let resolvedUpdate: UpdateObject<DB, TB> | undefined
  if (Array.isArray(options.update)) {
    for (const column of options.update as readonly Column<DB, TB>[]) {
      if (options.conflict.includes(column)) throw new Error(`upsert 不能更新冲突列 ${column}；请从 update 中移除`)
      for (const row of rows) {
        if ((row as Readonly<Record<string, unknown>>)[column] === undefined) {
          throw new Error(`upsert 更新列 ${column} 在某行没有值；请在每一行 values 中显式提供`)
        }
      }
    }
  } else {
    const update = options.update as UpdateObjectExpression<DB, TB>
    // 用 Kysely 解析对象和工厂；物化一次后复用，避免再次调用工厂时绕过已检查的列。
    const node = (db.updateTable(table) as unknown as UpdateQueryBuilder<DB, TB, TB, UpdateResult>)
      .set((eb) => {
        resolvedUpdate = { ...(typeof update === 'function' ? update(eb) : update) }
        return resolvedUpdate
      })
      .toOperationNode()
    for (const assignment of node.updates ?? []) {
      if (!ColumnNode.is(assignment.column)) throw new Error('upsert 无法确定更新列；请使用普通列名')
      const column = assignment.column.column.name
      if (options.conflict.includes(column as Column<DB, TB>)) {
        throw new Error(`upsert 不能更新冲突列 ${column}；请从 update 中移除`)
      }
    }
  }
  const keys = new Set<string>()
  const conflictValues = rows.map((row) => {
    const values = options.conflict.map((column) => {
      const value = (row as Readonly<Record<string, unknown>>)[column]
      if (value !== null && !['string', 'number', 'bigint', 'boolean'].includes(typeof value)) {
        throw new Error(`upsert 冲突列 ${column} 不能使用表达式或省略值；请提供原始值`)
      }
      return value as string | number | bigint | boolean | null
    })
    // SQL 唯一键中的 null 不构成冲突，因此这些行不能按重复键拒绝。
    if (!values.includes(null)) {
      const key = JSON.stringify(values.map((value) => [typeof value, String(value)]))
      if (keys.has(key)) throw new Error('upsert 批次存在重复冲突键；请先合并重复行再执行')
      keys.add(key)
    }
    return values
  })
  if (!rows.length) return
  if (dialectOf(db) === 'mysql') {
    const run = async (executor: Kysely<DB>): Promise<void> => {
      for (const [index, row] of rows.entries()) {
        const values = conflictValues[index]!
        const insert = () => executor.insertInto(table).values(row).executeTakeFirstOrThrow()
        if (values.includes(null)) {
          await insert()
          continue
        }
        const updates = (
          Array.isArray(options.update)
            ? Object.fromEntries(
                options.update.map((column: Column<DB, TB>) => [
                  column,
                  (row as Readonly<Record<string, unknown>>)[column],
                ]),
              )
            : resolvedUpdate!
        ) as UpdateObjectExpression<DB, TB>
        // 此接口只接受真实表名，Kysely 的别名条件类型在这里统一为 TB。
        let update = (executor.updateTable(table) as unknown as UpdateQueryBuilder<DB, TB, TB, UpdateResult>).set(
          updates,
        )
        for (const [position, column] of options.conflict.entries()) {
          update = update.where(sql<boolean>`${sql.ref(column)} = ${values[position]}`)
        }
        // 先 UPDATE 直接获取排他锁，避免先 INSERT 引起 InnoDB 共享锁升级的死锁。
        // mysql2 默认启用 FOUND_ROWS，未改变值的匹配行也会计数。
        if ((await update.executeTakeFirstOrThrow()).numUpdatedRows > 0n) continue
        try {
          await insert()
        } catch (error) {
          if (!isMysqlDuplicate(error)) throw error
          // 可能有并发插入；只重试指定冲突键，不能更新其他唯一键指向的行。
          if ((await update.executeTakeFirstOrThrow()).numUpdatedRows === 0n) throw error
        }
      }
    }
    if (db.isTransaction) await run(db)
    else {
      // InnoDB 死锁会回滚整个事务；只有本函数拥有事务时才可整体重试，最多执行三次。
      for (let attempt = 1; ; attempt++) {
        try {
          await db.transaction().execute(run)
          break
        } catch (error) {
          if (
            attempt >= 3 ||
            typeof error !== 'object' ||
            error === null ||
            !('errno' in error) ||
            error.errno !== 1213
          )
            throw error
        }
      }
    }
    return
  }
  const update = (
    Array.isArray(options.update)
      ? Object.fromEntries(options.update.map((column: string) => [column, sql.ref(`excluded.${column}`)]))
      : resolvedUpdate!
  ) as UpdateObjectExpression<DB, TB>
  // Kysely 为冲突更新添加虚拟 excluded 表，内部转换泛型以保留调用方的类型约束。
  await db
    .insertInto(table)
    .values(options.values)
    .onConflict((conflict) =>
      conflict
        .columns([...options.conflict])
        .doUpdateSet(update as unknown as Parameters<typeof conflict.doUpdateSet>[0]),
    )
    .execute()
}

/** 仅接收已过滤、尚未添加选择列、分组、条数限制或偏移量的查询。 */
export async function countRows<DB, TB extends keyof DB>(
  query: SelectQueryBuilder<DB, TB, Record<string, never>>,
): Promise<number> {
  const row = await query.select(sql<string | number | bigint>`count(*)`.as('row_count')).executeTakeFirstOrThrow()
  return toNumber(row.row_count)
}

export function createTable<DB, TB extends string>(db: Kysely<DB>, name: TB): CreateTableBuilder<TB, never> {
  const builder = db.schema.createTable(name)
  // 服主的默认排序规则可能忽略大小写或重音；统一使用 utf8mb4_bin，
  // 需要忽略大小写的字段由 schema 显式处理。
  return dialectOf(db) === 'mysql'
    ? builder.modifyEnd(sql`engine=InnoDB default charset=utf8mb4 collate=utf8mb4_bin`)
    : builder
}

export function autoIncrementId<DB, C extends string = 'id'>(db: Kysely<DB>, column: C = 'id' as C) {
  return <TB extends string, Columns extends string>(
    builder: CreateTableBuilder<TB, Columns>,
  ): CreateTableBuilder<TB, Columns | C> =>
    builder.addColumn(column, 'integer', (definition) => {
      if (dialectOf(db) === 'postgres') return definition.generatedByDefaultAsIdentity().primaryKey()
      // SQLite 需加 AUTOINCREMENT，防止重用已删除的 ID。
      return definition.primaryKey().autoIncrement()
    })
}

export async function syncAutoIncrement<DB, TB extends keyof DB & string>(
  db: Kysely<DB>,
  table: TB,
  column: NumericColumn<DB, TB> = 'id' as NumericColumn<DB, TB>,
): Promise<void> {
  if (dialectOf(db) !== 'postgres') return // SQLite 和 MySQL 在显式插入 ID 时自动推进。
  // pg_get_serial_sequence 接收表名文本，加引号才能保留标识符大小写。
  const relation = table
    .split('.')
    .map((part) => `"${part.replaceAll('"', '""')}"`)
    .join('.')
  const sync = async (executor: Kysely<DB>): Promise<void> => {
    // INSERT 需要 ROW EXCLUSIVE 锁；同步期间挡住它，避免 setval 覆盖并发分配的序列值。
    await sql`lock table ${sql.table(table)} in exclusive mode`.execute(executor)
    await sql`with sequence_state as (
    select pg_get_serial_sequence(${relation}, ${column})::regclass as sequence
  ), used as (
    select sequence, pg_sequence_last_value(sequence) as last_value,
      (select max(${sql.ref(column)}) from ${sql.table(table)}) as max_id
    from sequence_state
  ) select setval(sequence, greatest(coalesce(max_id, 1), coalesce(last_value, 1)),
      last_value is not null or coalesce(max_id >= 1, false))
    from used`.execute(executor)
  }
  if (db.isTransaction) await sync(db)
  else await db.transaction().execute(sync)
}

/**
 * MySQL / MariaDB 的自增计数器不随事务回滚：回滚了显式写入大 id 的事务之后，计数器仍停在那里，以后新建的行从那里接着编号。
 * 可能整体回滚的大事务（导入器）之前记下计数器，回滚之后用 restoreAutoIncrement 恢复。SQLite 的 sqlite_sequence 随事务回滚，
 * PostgreSQL 显式写入 id 不动序列，这两种返回空（syncAutoIncrement 的 setval 不随事务回滚，要在确定提交时才调用）。
 * 两个函数都要在事务之外调用：ALTER TABLE 会隐式提交
 */
export async function captureAutoIncrement<DB>(
  db: Kysely<DB>,
  tables: readonly (keyof DB & string)[],
): Promise<Map<string, number>> {
  const counters = new Map<string, number>()
  if (dialectOf(db) !== 'mysql') return counters
  for (const table of tables) {
    // information_schema 里的值在 MySQL 8 上有缓存；SHOW CREATE TABLE 读的是当前值，计数器还是 1 时不显示
    const result = await sql<Record<string, string>>`show create table ${sql.table(table)}`.execute(db)
    const statement = result.rows[0]?.['Create Table'] ?? ''
    counters.set(table, Number(/ AUTO_INCREMENT=(\d+)/.exec(statement)?.[1] ?? 1))
  }
  return counters
}

export async function restoreAutoIncrement<DB>(db: Kysely<DB>, counters: ReadonlyMap<string, number>): Promise<void> {
  // InnoDB 不会把计数器设到表里已有的最大 id 以下，所以恢复不会让新行撞上已有的行
  for (const [table, value] of counters)
    await sql`alter table ${sql.table(table)} auto_increment = ${sql.lit(value)}`.execute(db)
}

/** 按一列分组计数，返回 值 → 行数。只接收已过滤、尚未添加选择列、分组、条数限制或偏移量的查询 */
export async function countBy<DB, TB extends keyof DB>(
  query: SelectQueryBuilder<DB, TB, Record<string, never>>,
  column: Column<DB, TB>,
): Promise<Map<string | number, number>> {
  const rows = await query
    .select([
      sql<string | number>`${sql.ref(column)}`.as('group_key'),
      sql<string | number | bigint>`count(*)`.as('row_count'),
    ])
    .groupBy(sql.ref(column))
    .execute()
  return new Map(rows.map((row) => [row.group_key, toNumber(row.row_count)]))
}

function isMysqlDuplicate(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'errno' in error && error.errno === 1062
}

/** 只识别唯一键和主键冲突，不吞掉其他约束错误。 */
export function isUniqueViolation<DB>(db: Kysely<DB>, error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  switch (dialectOf(db)) {
    case 'mysql':
      return isMysqlDuplicate(error)
    case 'postgres':
      return 'code' in error && error.code === '23505'
    case 'sqlite':
      return (
        ('errcode' in error && (error.errcode === 2067 || error.errcode === 1555)) ||
        ('code' in error &&
          (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY'))
      )
  }
}

/**
 * `INSERT … SELECT` 从被引用的表里取外键的值时（例如给一批用户写通知），给源查询加上外键检查本来就要加的那种锁。
 * 两种服务器库的连接都是读已提交：不加锁的读看得到别的事务删掉、还没提交的行，外键检查等对方提交后报错（PostgreSQL
 * 23503、MySQL 1452），这种错误不会重试。加锁的读先等删除提交，再按最新的版本判断，删掉的行不选。PostgreSQL 用
 * FOR KEY SHARE，不挡不改主键的更新；MySQL、MariaDB 的外键检查加的就是共享锁。SQLite 的写锁是全局的，原样返回
 */
export function lockForReference<DB, TB extends keyof DB, O>(
  db: Kysely<DB>,
  query: SelectQueryBuilder<DB, TB, O>,
  table: TB & string,
): SelectQueryBuilder<DB, TB, O> {
  switch (dialectOf(db)) {
    case 'postgres':
      return query.forKeyShare(table)
    case 'mysql':
      // MariaDB 不认 FOR SHARE
      return query.modifyEnd(sql`lock in share mode`)
    case 'sqlite':
      return query
  }
}

// 品牌只存在于类型层；普通字符串必须先通过日期转换或格式校验。
declare const isoTimestampBrand: unique symbol
export type IsoTimestamp = string & { readonly [isoTimestampBrand]: true }
export type SwitchValue = 0 | 1

const ISO_TIMESTAMP_PATTERN = '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
const ISO_TIMESTAMP_REGEXP = new RegExp(ISO_TIMESTAMP_PATTERN)

export function isIsoTimestamp(value: string): value is IsoTimestamp {
  if (value.length !== 24 || !ISO_TIMESTAMP_REGEXP.test(value)) return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}

export function toIsoTimestamp(date: Date): IsoTimestamp {
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 0 || date.getUTCFullYear() > 9999) {
    throw new RangeError('ISO 时间必须是有效日期，且 UTC 年份在 0000–9999 之间')
  }
  return date.toISOString() as IsoTimestamp
}

/** CHECK 只检查格式；真实日历日期由 isIsoTimestamp / toIsoTimestamp 校验。 */
export function isoTimestampColumn<DB, C extends string>(
  db: Kysely<DB>,
  column: C,
  options: { nullable?: boolean } = {},
) {
  const ref = sql.ref(column)
  const dialect = dialectOf(db)
  const format =
    dialect === 'sqlite'
      ? sql<boolean>`${ref} glob ${sql.lit('dddd-dd-ddTdd:dd:dd.dddZ'.replaceAll('d', '[0-9]'))}`
      : dialect === 'mysql'
        ? // ICU 和 PCRE 都识别 (?-i)；不使用 BINARY（MySQL 8 的 ICU 拒绝二进制操作数）。
          sql<boolean>`${ref} regexp ${sql.lit('(?-i)' + ISO_TIMESTAMP_PATTERN)}`
        : sql<boolean>`${ref} ~ ${sql.lit(ISO_TIMESTAMP_PATTERN)}`
  // SQLite 的文本 length / glob 遇到 NUL 就停止；按字节计长才能拒绝隐藏后缀。
  const length = dialect === 'sqlite' ? sql`length(cast(${ref} as blob))` : sql`length(${ref})`
  return <TB extends string, Columns extends string>(builder: CreateTableBuilder<TB, Columns>) =>
    builder.addColumn(column, 'varchar(24)', (definition) => {
      const checked = definition.check(sql<boolean>`${length} = 24 and ${format}`)
      return options.nullable ? checked : checked.notNull()
    })
}

export function switchColumn<DB, C extends string>(
  db: Kysely<DB>,
  column: C,
  options: { defaultValue?: SwitchValue } = {},
) {
  // 保持所有列辅助函数一致的调用方式，并在构造时检查支持的方言。
  dialectOf(db)
  return <TB extends string, Columns extends string>(builder: CreateTableBuilder<TB, Columns>) =>
    builder.addColumn(column, 'smallint', (definition) => {
      const checked = definition.notNull().check(sql<boolean>`${sql.ref(column)} in (0, 1)`)
      return options.defaultValue === undefined ? checked : checked.defaultTo(options.defaultValue)
    })
}

export function longTextType<DB>(db: Kysely<DB>) {
  return dialectOf(db) === 'mysql' ? sql`longtext` : sql`text`
}

export async function addForeignKeyColumn<DB>(
  db: Kysely<DB>,
  options: {
    table: string
    column: string
    references: { table: string; column: string }
    onDelete: 'cascade' | 'set null' | 'restrict' | 'no action'
    constraintName: string
  },
): Promise<void> {
  const actions = {
    cascade: sql`cascade`,
    'set null': sql`set null`,
    restrict: sql`restrict`,
    'no action': sql`no action`,
  }
  const action = actions[options.onDelete]
  if (!action) throw new Error('外键删除行为无效；请使用 cascade、set null、restrict 或 no action')
  const reference = sql`references ${sql.id(options.references.table)} (${sql.id(options.references.column)}) on delete ${action}`
  const constraint = sql`constraint ${sql.id(options.constraintName)}`
  const addition =
    dialectOf(db) === 'sqlite'
      ? sql` ${constraint} ${reference}`
      : sql`, add ${constraint} foreign key (${sql.id(options.column)}) ${reference}`
  // 没有 NOT NULL 或非 NULL 默认值；SQLite 外键开启时只允许以 NULL 回填旧行。
  await sql`alter table ${sql.id(options.table)} add column ${sql.id(options.column)} integer${addition}`.execute(db)
}

export function authDateType<DB>(db: Kysely<DB>) {
  const dialect = dialectOf(db)
  return dialect === 'mysql' ? sql`datetime(3)` : dialect === 'postgres' ? sql`timestamptz(3)` : sql`date`
}

export function authBooleanType<DB>(db: Kysely<DB>) {
  return dialectOf(db) === 'sqlite' ? sql`integer` : sql`boolean`
}

export function authJsonType<DB>(db: Kysely<DB>) {
  const dialect = dialectOf(db)
  return dialect === 'sqlite' ? sql`text` : dialect === 'mysql' ? sql`json` : sql`jsonb`
}

/**
 * ascii：只存 ASCII 的列（例如 base64url）在 MySQL 上改用 ascii 字符集，每个字符 1 字节，
 * 单列索引能到 3072 个字符，而 utf8mb4 只有 768 个。写入非 ASCII 字符时 MySQL 报错，不会静默截断
 */
export function authStringType<DB>(db: Kysely<DB>, length: number, options: { ascii?: boolean } = {}) {
  const dialect = dialectOf(db)
  if (dialect === 'sqlite') return sql`text`
  return dialect === 'mysql' && options.ascii
    ? sql`varchar(${sql.lit(length)}) character set ascii collate ascii_bin`
    : sql`varchar(${sql.lit(length)})`
}

/**
 * 把已有的 text 列改成 `authStringType`，好给它建索引（MySQL 不能直接给 text 建索引）。SQLite 上两者都是 text，什么也不做。
 * 可空的列要传 `nullable`；已有的值超长或（ascii 时）含非 ASCII 字符，MySQL 和 PG 都会报错，不会静默截断
 */
export async function alterToAuthStringColumn<DB>(
  db: Kysely<DB>,
  table: string,
  column: string,
  length: number,
  options: { ascii?: boolean; nullable?: boolean } = {},
): Promise<void> {
  const dialect = dialectOf(db)
  if (dialect === 'sqlite') return
  const type = authStringType(db, length, options)
  // MySQL 的 MODIFY COLUMN 会重写整列的定义，NOT NULL 要重新写上；PG 的 ALTER COLUMN TYPE 不改可空性
  await (
    dialect === 'mysql'
      ? sql`alter table ${sql.id(table)} modify column ${sql.id(column)} ${type} ${options.nullable ? sql`null` : sql`not null`}`
      : sql`alter table ${sql.id(table)} alter column ${sql.id(column)} type ${type}`
  ).execute(db)
}

export function readAuthDate(value: unknown): IsoTimestamp {
  if (value instanceof Date) return toIsoTimestamp(value)
  if (typeof value === 'string' && isIsoTimestamp(value)) return value
  throw new TypeError('认证日期必须是有效的 Date 或 UTC 毫秒 ISO 时间字符串')
}

export function writeAuthDate<DB>(db: Kysely<DB>, value: IsoTimestamp): string | Date {
  // 品牌不能保护 JavaScript 调用方或被断言的值，写入前仍需校验。
  const timestamp = readAuthDate(value)
  return dialectOf(db) === 'sqlite' ? timestamp : new Date(timestamp)
}

export function readAuthBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (value === 0 || value === 1) return value === 1
  throw new TypeError('认证布尔值必须是 boolean 或数字 0 / 1')
}

/** Literal substring search. SQLite lower() folds ASCII only; no dialect-specific Unicode promise. */
export function containsInsensitive(column: string, value: string): RawBuilder<SqlBool> {
  const escaped = value.replace(/[!%_]/g, (character) => `!${character}`)
  return sql<SqlBool>`lower(${sql.ref(column)}) like lower(${`%${escaped}%`}) escape '!'`
}
