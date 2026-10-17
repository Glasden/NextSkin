import {
  ColumnNode,
  MysqlAdapter,
  PostgresAdapter,
  SqliteAdapter,
  sql,
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

function isMysqlDuplicate(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'errno' in error && error.errno === 1062
}
