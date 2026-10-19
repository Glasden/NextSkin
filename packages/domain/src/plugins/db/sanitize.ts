/**
 * 核心侧：把插件发来的 Kysely 操作节点树"重建"成一棵只包含允许内容的新树。
 *
 * 插件进程可能被完全控制，发来的不一定是 Kysely 生成的树，而是任意可结构化克隆的对象。
 * 所以这里不做"检查"，而是"重建"：
 * - 每种节点类型单独处理，只复制已知字段；出现未知类型或多余字段一律拒绝；
 * - 会被原样拼进 SQL 的字段（运算符、函数名、数据类型、外键动作、排序方向……）走白名单；
 * - 数据来源位置（FROM / JOIN / INTO / UPDATE / DELETE / DDL 目标）只能是本插件声明过的表，
 *   并改写成带前缀的物理表名；引用限定符只能是声明过的表或本查询里定义的别名；
 * - 拒绝原始 SQL（RawNode）、CTE、schema 限定、立即值（DML 中）、EXPLAIN 等。
 * 重建后的树由核心用自己的方言编译器重新编译执行，插件发来的 SQL 字符串从不使用。
 */
import { isColumnDataType, type RootOperationNode } from 'kysely'

export class PluginQueryRejected extends Error {
  override name = 'PluginQueryRejected'
}

export interface SanitizeOptions {
  pluginId: string
  /** 插件声明的逻辑表名 */
  tables: ReadonlySet<string>
  /** 只有在迁移调用里才允许 DDL */
  allowDdl: boolean
}

const MAX_NODES = 5000
const MAX_DEPTH = 64
const MAX_LIST = 1000
const MAX_STRING_PARAM = 64 * 1024
const MAX_BINARY_PARAM = 256 * 1024
/** 列名、别名：大小写敏感性随数据库而变，但只在本插件自己的表内部生效，不影响隔离 */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,47}$/
/**
 * 表名、索引名、约束名会拼进物理名 `p_<插件>__<名字>`，必须保证不同插件拼出来的名字不可能相同：
 * - 只用小写（SQLite 和部分文件系统上的 MySQL 不区分表名大小写）；
 * - 不允许连续下划线、不允许以下划线结尾，这样 `__` 在物理名里只会出现一次，可以唯一拆分。
 */
const OBJECT_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/
/** 插件 id：小写字母数字，用单个连字符分隔；拼进物理名时连字符换成下划线 */
export const PLUGIN_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const MAX_PHYSICAL_IDENT = 63

/** 三种数据库语义一致的运算符。不含 `||`（MySQL 里是 OR）和各方言特有运算符。 */
const BINARY_OPERATORS = new Set([
  '=',
  '!=',
  '<>',
  '>',
  '>=',
  '<',
  '<=',
  'in',
  'not in',
  'is',
  'is not',
  'like',
  'not like',
  'between',
  '+',
  '-',
  '*',
  '/',
  '%',
])
const UNARY_OPERATORS = new Set(['not', 'exists', 'not exists', '-'])
const FUNCTIONS = new Set(['lower', 'upper', 'abs', 'round', 'coalesce', 'nullif'])
const AGGREGATES = new Set(['count', 'sum', 'avg', 'min', 'max'])
const JOIN_TYPES = new Set(['InnerJoin', 'LeftJoin'])
const SELECT_MODIFIERS = new Set(['Distinct'])
const FK_ACTIONS = new Set(['cascade', 'set null', 'restrict', 'no action'])
const DATA_TYPE =
  /^(?:varchar\((\d{1,4})\)|char\((\d{1,3})\)|text|integer|bigint|smallint|boolean|real|double precision|(?:numeric|decimal)\(\d{1,2}, \d{1,2}\))$/
const SAFE_DEFAULT_STRING = /^[\p{L}\p{N} _.:-]{0,64}$/u

type N = Record<string, unknown>

export function sanitizePluginQuery(input: unknown, options: SanitizeOptions): RootOperationNode {
  if (!PLUGIN_ID.test(options.pluginId)) throw new PluginQueryRejected(`invalid plugin id ${options.pluginId}`)
  for (const table of options.tables) physicalName(options.pluginId, table)
  return new Rebuilder(options, collectAliases(input)).root(input)
}

/**
 * 一个插件的物理名都以它开头：`p_<插件 id，连字符换成下划线>__`。插件 id 里没有连续的连字符、对象名不以下划线开头，
 * 所以不同插件的前缀互不包含
 */
export function physicalPrefix(pluginId: string): string {
  if (!PLUGIN_ID.test(pluginId)) throw new PluginQueryRejected(`invalid plugin id ${pluginId}`)
  return `p_${pluginId.replaceAll('-', '_')}__`
}

/** 物理名：`p_<插件 id，连字符换成下划线>__<对象名>`。 */
export function physicalName(pluginId: string, name: string): string {
  const prefix = physicalPrefix(pluginId)
  if (!OBJECT_NAME.test(name)) throw new PluginQueryRejected(`invalid object name ${JSON.stringify(name)}`)
  const physical = `${prefix}${name}`
  if (physical.length > MAX_PHYSICAL_IDENT) throw new PluginQueryRejected(`physical name too long: ${physical}`)
  return physical
}

/** 第一遍：收集本查询里定义的所有别名。别名只能出现在引用限定符里，永远不能当数据来源。 */
function collectAliases(input: unknown): Set<string> {
  const aliases = new Set<string>()
  let count = 0
  let bytes = 0
  const walk = (value: unknown, depth: number) => {
    if (depth > MAX_DEPTH) throw new PluginQueryRejected('query too deep')
    if (++count > MAX_NODES) throw new PluginQueryRejected('query too large')
    // 先累计载荷，避免为超限的多组二进制参数分配整份序列化消息。
    if (typeof value === 'string') bytes += Buffer.byteLength(value, 'utf8')
    else if (ArrayBuffer.isView(value)) bytes += value.byteLength
    if (bytes > 1024 * 1024) throw new PluginQueryRejected('query message exceeds 1 MiB')
    if (Array.isArray(value)) return value.forEach((item) => walk(item, depth + 1))
    // 二进制参数不是节点，不要逐字节遍历
    if (!value || typeof value !== 'object' || ArrayBuffer.isView(value)) return
    const node = value as N
    if (
      node.kind === 'AliasNode' &&
      (node.alias as N | null)?.kind === 'IdentifierNode' &&
      typeof (node.alias as N).name === 'string'
    )
      aliases.add((node.alias as N).name as string)
    for (const key of Object.keys(node)) walk(node[key], depth + 1)
  }
  walk(input, 0)
  return aliases
}

class Rebuilder {
  private nodes = 0

  private readonly options: SanitizeOptions
  private readonly aliases: ReadonlySet<string>

  constructor(options: SanitizeOptions, aliases: ReadonlySet<string>) {
    this.options = options
    this.aliases = aliases
  }

  private fail(message: string): never {
    throw new PluginQueryRejected(message)
  }

  /** 校验是节点、类型正确、且没有白名单以外的字段。 */
  private node(value: unknown, kind: string | readonly string[], allowed: readonly string[], depth: number): N {
    if (depth > MAX_DEPTH) this.fail('query too deep')
    if (++this.nodes > MAX_NODES) this.fail('query too large')
    if (!value || typeof value !== 'object' || Array.isArray(value))
      this.fail(`expected ${typeof kind === 'string' ? kind : kind.join('|')}`)
    const node = value as N
    const kinds = typeof kind === 'string' ? [kind] : kind
    if (!kinds.includes(String(node.kind)))
      this.fail(`node ${String(node.kind)} not allowed here (expected ${kinds.join('|')})`)
    for (const key of Object.keys(node)) {
      if (key !== 'kind' && !allowed.includes(key) && node[key] !== undefined)
        this.fail(`${String(node.kind)}.${key} is not allowed`)
    }
    return node
  }

  private list<T>(value: unknown, map: (item: unknown) => T, max = MAX_LIST): T[] {
    if (!Array.isArray(value)) this.fail('expected list')
    if (value.length > max) this.fail('list too long')
    return value.map(map)
  }

  private bool(value: unknown): boolean | undefined {
    if (value === undefined) return undefined
    if (typeof value !== 'boolean') this.fail('expected boolean')
    return value
  }

  private name(value: unknown): string {
    if (typeof value !== 'string' || !IDENT.test(value)) this.fail(`invalid identifier ${JSON.stringify(value)}`)
    return value
  }

  private physical(logical: string): string {
    return physicalName(this.options.pluginId, logical)
  }

  private identifier(value: unknown, depth: number) {
    const node = this.node(value, 'IdentifierNode', ['name'], depth)
    return freeze({ kind: 'IdentifierNode', name: this.name(node.name) })
  }

  private tableNodeOf(name: string) {
    return freeze({
      kind: 'TableNode',
      table: freeze({ kind: 'SchemableIdentifierNode', identifier: freeze({ kind: 'IdentifierNode', name }) }),
    })
  }

  /** 读取 TableNode 的名字；带 schema 一律拒绝。 */
  private tableName(value: unknown, depth: number): string {
    const table = this.node(value, 'TableNode', ['table'], depth)
    const schemable = this.node(table.table, 'SchemableIdentifierNode', ['identifier', 'schema'], depth + 1)
    if (schemable.schema !== undefined) this.fail('schema-qualified tables are not allowed')
    return this.identifier(schemable.identifier, depth + 2).name
  }

  /** 数据来源位置：只能是声明过的表。 */
  private declaredTable(value: unknown, depth: number) {
    const name = this.tableName(value, depth)
    if (!this.options.tables.has(name)) this.fail(`table ${name} is not declared by this plugin`)
    return this.tableNodeOf(this.physical(name))
  }

  /** 引用限定符：声明过的表（改名）、本查询定义的别名（保留），或 upsert 里的 excluded。 */
  private qualifier(value: unknown, depth: number, ctx: Ctx) {
    const name = this.tableName(value, depth)
    const isTable = this.options.tables.has(name)
    const isAlias = this.aliases.has(name)
    if (isTable && isAlias) this.fail(`ambiguous qualifier ${name}`)
    if (isTable) return this.tableNodeOf(this.physical(name))
    if (isAlias) return this.tableNodeOf(name)
    if (name === 'excluded' && ctx.inOnConflict) return this.tableNodeOf(name)
    this.fail(`unknown qualifier ${name}`)
  }

  private column(value: unknown, depth: number) {
    const node = this.node(value, 'ColumnNode', ['column'], depth)
    return freeze({ kind: 'ColumnNode', column: this.identifier(node.column, depth + 1) })
  }

  root(value: unknown): RootOperationNode {
    return this.rootNode(value) as unknown as RootOperationNode
  }

  private rootNode(value: unknown): N {
    const kind = (value as N | null)?.kind
    switch (kind) {
      case 'SelectQueryNode':
        return this.select(value, 0, {})
      case 'InsertQueryNode':
        return this.insert(value, 0)
      case 'UpdateQueryNode':
        return this.update(value, 0)
      case 'DeleteQueryNode':
        return this.delete(value, 0)
      case 'CreateTableNode':
      case 'CreateIndexNode':
      case 'DropTableNode':
      case 'DropIndexNode':
      case 'AlterTableNode':
        if (!this.options.allowDdl) this.fail('DDL is only allowed during plugin migrations')
        return this.ddl(value, 0)
      default:
        this.fail(`root node ${String(kind)} not allowed`)
    }
  }

  private select(value: unknown, depth: number, ctx: Ctx): N {
    const n = this.node(
      value,
      'SelectQueryNode',
      [
        'from',
        'selections',
        'joins',
        'where',
        'groupBy',
        'having',
        'orderBy',
        'limit',
        'offset',
        'frontModifiers',
        'endModifiers',
      ],
      depth,
    )
    const d = depth + 1
    return freeze({
      kind: 'SelectQueryNode',
      from: n.from && this.from(n.from, d),
      selections: n.selections && this.list(n.selections, (s) => this.selection(s, d, ctx)),
      joins: n.joins && this.list(n.joins, (j) => this.join(j, d, ctx), 4),
      where: n.where && this.where(n.where, d, ctx),
      groupBy: n.groupBy && this.groupBy(n.groupBy, d, ctx),
      having:
        n.having &&
        freeze({
          kind: 'HavingNode',
          having: this.expr(this.node(n.having, 'HavingNode', ['having'], d).having, d + 1, ctx),
        }),
      orderBy: n.orderBy && this.orderBy(n.orderBy, d, ctx),
      limit: n.limit && this.limitLike(n.limit, 'LimitNode', 'limit', d),
      offset: n.offset && this.limitLike(n.offset, 'OffsetNode', 'offset', d),
      frontModifiers: n.frontModifiers && this.list(n.frontModifiers, (m) => this.modifier(m, d)),
      endModifiers: n.endModifiers && this.list(n.endModifiers, (m) => this.modifier(m, d)),
    })
  }

  private from(value: unknown, depth: number) {
    const n = this.node(value, 'FromNode', ['froms'], depth)
    // 只允许一个 FROM 项：逗号连接的多表 FROM 就是笛卡尔积，多表请用带 ON 的 JOIN
    return freeze({ kind: 'FromNode', froms: this.list(n.froms, (f) => this.source(f, depth + 1), 1) })
  }

  /** FROM / JOIN 项：声明过的表，或带别名的表/子查询。 */
  private source(value: unknown, depth: number): N {
    if ((value as N | null)?.kind === 'AliasNode') {
      const n = this.node(value, 'AliasNode', ['node', 'alias'], depth)
      const inner =
        (n.node as N | null)?.kind === 'SelectQueryNode'
          ? this.select(n.node, depth + 1, {})
          : this.declaredTable(n.node, depth + 1)
      return freeze({ kind: 'AliasNode', node: inner, alias: this.identifier(n.alias, depth + 1) })
    }
    return this.declaredTable(value, depth)
  }

  private join(value: unknown, depth: number, ctx: Ctx) {
    const n = this.node(value, 'JoinNode', ['joinType', 'table', 'on'], depth)
    if (!JOIN_TYPES.has(typeof n.joinType === 'string' ? n.joinType : ''))
      this.fail(`join type ${typeof n.joinType === 'string' ? n.joinType : ''} not allowed`)
    const on = this.node(n.on, 'OnNode', ['on'], depth + 1)
    return freeze({
      kind: 'JoinNode',
      joinType: n.joinType,
      table: this.source(n.table, depth + 1),
      on: freeze({ kind: 'OnNode', on: this.expr(on.on, depth + 2, ctx) }),
    })
  }

  private where(value: unknown, depth: number, ctx: Ctx) {
    const n = this.node(value, 'WhereNode', ['where'], depth)
    return freeze({ kind: 'WhereNode', where: this.expr(n.where, depth + 1, ctx) })
  }

  private selection(value: unknown, depth: number, ctx: Ctx) {
    const n = this.node(value, 'SelectionNode', ['selection'], depth)
    return freeze({
      kind: 'SelectionNode',
      selection: this.expr(n.selection, depth + 1, ctx, { allowSelectAll: true }),
    })
  }

  private groupBy(value: unknown, depth: number, ctx: Ctx) {
    const n = this.node(value, 'GroupByNode', ['items'], depth)
    return freeze({
      kind: 'GroupByNode',
      items: this.list(n.items, (item) => {
        const i = this.node(item, 'GroupByItemNode', ['groupBy'], depth + 1)
        return freeze({ kind: 'GroupByItemNode', groupBy: this.expr(i.groupBy, depth + 2, ctx) })
      }),
    })
  }

  private orderBy(value: unknown, depth: number, ctx: Ctx) {
    const n = this.node(value, 'OrderByNode', ['items'], depth)
    return freeze({
      kind: 'OrderByNode',
      items: this.list(
        n.items,
        (item) => {
          const i = this.node(item, 'OrderByItemNode', ['orderBy', 'direction', 'nulls'], depth + 1)
          let direction
          if (i.direction !== undefined) {
            // Kysely 用 RawNode 表示排序方向，这是唯一允许 RawNode 的位置，内容只能是 asc/desc
            const raw = this.node(i.direction, 'RawNode', ['sqlFragments', 'parameters'], depth + 2)
            const fragment: unknown =
              Array.isArray(raw.sqlFragments) && raw.sqlFragments.length === 1 ? raw.sqlFragments[0] : null
            if ((fragment !== 'asc' && fragment !== 'desc') || (Array.isArray(raw.parameters) && raw.parameters.length))
              this.fail('invalid order direction')
            direction = freeze({ kind: 'RawNode', sqlFragments: freeze([fragment]), parameters: freeze([]) })
          }
          if (i.nulls !== undefined && i.nulls !== 'first' && i.nulls !== 'last') this.fail('invalid nulls ordering')
          return freeze({
            kind: 'OrderByItemNode',
            orderBy: this.expr(i.orderBy, depth + 2, ctx),
            direction,
            nulls: i.nulls,
          })
        },
        8,
      ),
    })
  }

  private limitLike(value: unknown, kind: 'LimitNode' | 'OffsetNode', key: 'limit' | 'offset', depth: number) {
    const n = this.node(value, kind, [key], depth)
    const v = this.node(n[key], 'ValueNode', ['value'], depth + 1)
    if (typeof v.value !== 'number' || !Number.isSafeInteger(v.value) || v.value < 0) this.fail(`invalid ${key}`)
    return freeze({ kind, [key]: freeze({ kind: 'ValueNode', value: v.value }) })
  }

  private modifier(value: unknown, depth: number) {
    const n = this.node(value, 'SelectModifierNode', ['modifier'], depth)
    if (!SELECT_MODIFIERS.has(typeof n.modifier === 'string' ? n.modifier : ''))
      this.fail(`select modifier ${typeof n.modifier === 'string' ? n.modifier : ''} not allowed`)
    return freeze({ kind: 'SelectModifierNode', modifier: n.modifier })
  }

  private insert(value: unknown, depth: number): N {
    const n = this.node(
      value,
      'InsertQueryNode',
      ['into', 'columns', 'values', 'returning', 'onConflict', 'onDuplicateKey', 'defaultValues', 'orAction'],
      depth,
    )
    const d = depth + 1
    let values
    if (n.values !== undefined) {
      // 不支持 INSERT ... SELECT：一条语句就能写入成倍放大的行数，而且行数上限只能在写完之后才知道
      const v = this.node(n.values, 'ValuesNode', ['values'], d)
      values = freeze({ kind: 'ValuesNode', values: this.list(v.values, (row) => this.valuesRow(row, d + 1)) })
    }
    let orAction
    if (n.orAction !== undefined) {
      const o = this.node(n.orAction, 'OrActionNode', ['action'], d)
      if (o.action !== 'ignore') this.fail('only "or ignore" is allowed')
      orAction = freeze({ kind: 'OrActionNode', action: 'ignore' })
    }
    return freeze({
      kind: 'InsertQueryNode',
      into: this.declaredTable(n.into, d),
      columns: n.columns && this.list(n.columns, (c) => this.column(c, d)),
      values,
      returning: n.returning && this.returning(n.returning, d),
      onConflict: n.onConflict && this.conflict(n.onConflict, d),
      onDuplicateKey:
        n.onDuplicateKey &&
        freeze({
          kind: 'OnDuplicateKeyNode',
          updates: this.list(this.node(n.onDuplicateKey, 'OnDuplicateKeyNode', ['updates'], d).updates, (u) =>
            this.columnUpdate(u, d + 1, { inOnDuplicateKey: true }),
          ),
        }),
      defaultValues: this.bool(n.defaultValues),
      orAction,
    })
  }

  private valuesRow(value: unknown, depth: number) {
    if ((value as N | null)?.kind === 'PrimitiveValueListNode') {
      const n = this.node(value, 'PrimitiveValueListNode', ['values'], depth)
      return freeze({ kind: 'PrimitiveValueListNode', values: freeze(this.list(n.values, (v) => this.primitive(v))) })
    }
    const n = this.node(value, 'ValueListNode', ['values'], depth)
    return freeze({ kind: 'ValueListNode', values: this.list(n.values, (v) => this.expr(v, depth + 1, {})) })
  }

  private conflict(value: unknown, depth: number) {
    const n = this.node(value, 'OnConflictNode', ['columns', 'updates', 'updateWhere', 'doNothing'], depth)
    const ctx: Ctx = { inOnConflict: true }
    return freeze({
      kind: 'OnConflictNode',
      columns: n.columns && this.list(n.columns, (c) => this.column(c, depth + 1)),
      updates: n.updates && this.list(n.updates, (u) => this.columnUpdate(u, depth + 1, ctx)),
      updateWhere: n.updateWhere && this.where(n.updateWhere, depth + 1, ctx),
      doNothing: this.bool(n.doNothing),
    })
  }

  private columnUpdate(value: unknown, depth: number, ctx: Ctx) {
    const n = this.node(value, 'ColumnUpdateNode', ['column', 'value'], depth)
    return freeze({
      kind: 'ColumnUpdateNode',
      column: this.column(n.column, depth + 1),
      value: this.expr(n.value, depth + 1, ctx),
    })
  }

  private returning(value: unknown, depth: number) {
    const n = this.node(value, 'ReturningNode', ['selections'], depth)
    return freeze({
      kind: 'ReturningNode',
      selections: this.list(n.selections, (s) => this.selection(s, depth + 1, {})),
    })
  }

  // UPDATE / DELETE 不支持 RETURNING：返回行数没有上限，超限时写入已经发生。
  // INSERT 的 RETURNING 行数受 VALUES 行数上限约束，所以保留。

  private update(value: unknown, depth: number): N {
    const n = this.node(value, 'UpdateQueryNode', ['table', 'where', 'updates', 'limit', 'orderBy'], depth)
    const d = depth + 1
    return freeze({
      kind: 'UpdateQueryNode',
      table: this.source(n.table, d),
      where: n.where && this.where(n.where, d, {}),
      updates: this.list(n.updates, (u) => this.columnUpdate(u, d, {})),
      limit: n.limit && this.limitLike(n.limit, 'LimitNode', 'limit', d),
      orderBy: n.orderBy && this.orderBy(n.orderBy, d, {}),
    })
  }

  private delete(value: unknown, depth: number): N {
    const n = this.node(value, 'DeleteQueryNode', ['from', 'where', 'limit', 'orderBy'], depth)
    const d = depth + 1
    return freeze({
      kind: 'DeleteQueryNode',
      from: this.from(n.from, d),
      where: n.where && this.where(n.where, d, {}),
      limit: n.limit && this.limitLike(n.limit, 'LimitNode', 'limit', d),
      orderBy: n.orderBy && this.orderBy(n.orderBy, d, {}),
    })
  }

  /**
   * 参数值。不接受 Date：排在第一位时 node:sqlite 会把它当成命名参数表吞掉、后续参数整体错位（见 S2），各驱动的时区处理也不一致；
   * 插件 API 的约定是日期一律用 ISO 字符串。
   */
  private primitive(value: unknown) {
    if (value === null || typeof value === 'boolean') return value
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'bigint' && value >= -(2n ** 63n) && value < 2n ** 63n) return value
    if (typeof value === 'string') {
      if (Buffer.byteLength(value, 'utf8') > MAX_STRING_PARAM) this.fail('string parameter too long')
      return value
    }
    if (value instanceof Uint8Array) {
      if (value.byteLength > MAX_BINARY_PARAM) this.fail('binary parameter too large')
      return value
    }
    this.fail('unsupported parameter value (use ISO strings for dates)')
  }

  private expr(value: unknown, depth: number, ctx: Ctx, opts: { allowSelectAll?: boolean } = {}): N {
    const kind = (value as N | null)?.kind
    const d = depth + 1
    switch (kind) {
      case 'ReferenceNode': {
        const n = this.node(value, 'ReferenceNode', ['column', 'table'], depth)
        const isAll = (n.column as N | null)?.kind === 'SelectAllNode'
        if (isAll && !opts.allowSelectAll) this.fail('select-all not allowed here')
        return freeze({
          kind: 'ReferenceNode',
          column: isAll ? this.selectAll(n.column, d) : this.column(n.column, d),
          table: n.table && this.qualifier(n.table, d, ctx),
        })
      }
      case 'ColumnNode':
        return this.column(value, depth)
      case 'SelectAllNode':
        if (!opts.allowSelectAll) this.fail('select-all not allowed here')
        return this.selectAll(value, depth)
      case 'ValueNode': {
        // 立即值会被直接拼进 SQL；DML 里一律走参数。唯一的例外是 null 和布尔：
        // Kysely 把 `is null`、`is not true` 的右边编成立即值，MySQL 和 PostgreSQL 的 IS 后面不能跟参数
        const n = this.node(value, 'ValueNode', ['value', 'immediate'], depth)
        if (n.immediate !== undefined) {
          if (n.immediate !== true || (n.value !== null && typeof n.value !== 'boolean'))
            this.fail('ValueNode.immediate is only allowed for null and booleans')
          return freeze({ kind: 'ValueNode', value: n.value, immediate: true })
        }
        return freeze({ kind: 'ValueNode', value: this.primitive(n.value) })
      }
      case 'ValueListNode': {
        const n = this.node(value, 'ValueListNode', ['values'], depth)
        return freeze({ kind: 'ValueListNode', values: this.list(n.values, (v) => this.expr(v, d, ctx)) })
      }
      case 'PrimitiveValueListNode': {
        const n = this.node(value, 'PrimitiveValueListNode', ['values'], depth)
        return freeze({ kind: 'PrimitiveValueListNode', values: freeze(this.list(n.values, (v) => this.primitive(v))) })
      }
      case 'BinaryOperationNode': {
        const n = this.node(value, 'BinaryOperationNode', ['leftOperand', 'operator', 'rightOperand'], depth)
        return freeze({
          kind: 'BinaryOperationNode',
          leftOperand: this.expr(n.leftOperand, d, ctx),
          operator: this.operator(n.operator, BINARY_OPERATORS, d),
          rightOperand: this.expr(n.rightOperand, d, ctx),
        })
      }
      case 'UnaryOperationNode': {
        const n = this.node(value, 'UnaryOperationNode', ['operator', 'operand'], depth)
        const operator = this.operator(n.operator, UNARY_OPERATORS, d)
        const operand = this.expr(n.operand, d, ctx)
        return freeze({
          kind: 'UnaryOperationNode',
          operator,
          // 编译器在一元负号后面不加空格，两个负号连在一起就是 SQL 行注释 `--`；统一加括号
          operand: operator.operator === '-' ? freeze({ kind: 'ParensNode', node: operand }) : operand,
        })
      }
      case 'AndNode':
      case 'OrNode': {
        const n = this.node(value, kind, ['left', 'right'], depth)
        return freeze({ kind, left: this.expr(n.left, d, ctx), right: this.expr(n.right, d, ctx) })
      }
      case 'ParensNode': {
        const n = this.node(value, 'ParensNode', ['node'], depth)
        return freeze({ kind: 'ParensNode', node: this.expr(n.node, d, ctx) })
      }
      case 'AliasNode': {
        const n = this.node(value, 'AliasNode', ['node', 'alias'], depth)
        return freeze({ kind: 'AliasNode', node: this.expr(n.node, d, ctx), alias: this.identifier(n.alias, d) })
      }
      case 'SelectQueryNode':
        return this.select(value, depth, {})
      case 'FunctionNode': {
        const n = this.node(value, 'FunctionNode', ['func', 'arguments'], depth)
        const allowed =
          FUNCTIONS.has(typeof n.func === 'string' ? n.func : '') || (n.func === 'values' && ctx.inOnDuplicateKey)
        if (!allowed) this.fail(`function ${typeof n.func === 'string' ? n.func : ''} not allowed`)
        return freeze({
          kind: 'FunctionNode',
          func: n.func,
          arguments: this.list(n.arguments, (a) => this.expr(a, d, ctx), 8),
        })
      }
      case 'AggregateFunctionNode': {
        const n = this.node(value, 'AggregateFunctionNode', ['func', 'aggregated', 'distinct'], depth)
        if (!AGGREGATES.has(typeof n.func === 'string' ? n.func : ''))
          this.fail(`aggregate ${typeof n.func === 'string' ? n.func : ''} not allowed`)
        return freeze({
          kind: 'AggregateFunctionNode',
          func: n.func,
          aggregated: this.list(
            n.aggregated,
            (a) => ((a as N | null)?.kind === 'SelectionNode' ? this.selection(a, d, ctx) : this.expr(a, d, ctx)),
            2,
          ),
          distinct: this.bool(n.distinct),
        })
      }
      case 'CaseNode': {
        const n = this.node(value, 'CaseNode', ['value', 'when', 'else', 'isStatement'], depth)
        return freeze({
          kind: 'CaseNode',
          value: n.value && this.expr(n.value, d, ctx),
          when:
            n.when &&
            this.list(
              n.when,
              (w) => {
                const wn = this.node(w, 'WhenNode', ['condition', 'result'], d)
                return freeze({
                  kind: 'WhenNode',
                  condition: this.expr(wn.condition, d + 1, ctx),
                  result: wn.result && this.expr(wn.result, d + 1, ctx),
                })
              },
              32,
            ),
          else: n.else && this.expr(n.else, d, ctx),
          isStatement: this.bool(n.isStatement),
        })
      }
      case 'TupleNode': {
        const n = this.node(value, 'TupleNode', ['values'], depth)
        return freeze({ kind: 'TupleNode', values: this.list(n.values, (v) => this.expr(v, d, ctx), 16) })
      }
      case 'DefaultInsertValueNode':
        this.node(value, 'DefaultInsertValueNode', [], depth)
        return freeze({ kind: 'DefaultInsertValueNode' })
      default:
        this.fail(`node ${String(kind)} not allowed in expressions`)
    }
  }

  private selectAll(value: unknown, depth: number) {
    this.node(value, 'SelectAllNode', [], depth)
    return freeze({ kind: 'SelectAllNode' })
  }

  private operator(value: unknown, allowed: ReadonlySet<string>, depth: number) {
    const n = this.node(value, 'OperatorNode', ['operator'], depth)
    if (!allowed.has(typeof n.operator === 'string' ? n.operator : ''))
      this.fail(`operator ${JSON.stringify(n.operator)} not allowed`)
    return freeze({ kind: 'OperatorNode', operator: n.operator })
  }

  private ddl(value: unknown, depth: number): N {
    const kind = (value as N).kind as string
    const d = depth + 1
    switch (kind) {
      case 'CreateTableNode': {
        const n = this.node(value, kind, ['table', 'columns', 'constraints', 'ifNotExists'], depth)
        return freeze({
          kind,
          table: this.declaredTable(n.table, d),
          columns: this.list(n.columns, (c) => this.columnDefinition(c, d), 64),
          constraints: n.constraints && this.list(n.constraints, (c) => this.constraint(c, d), 16),
          ifNotExists: this.bool(n.ifNotExists),
        })
      }
      case 'CreateIndexNode': {
        const n = this.node(value, kind, ['name', 'table', 'columns', 'unique', 'ifNotExists'], depth)
        return freeze({
          kind,
          name: this.prefixedName(n.name, d),
          table: this.declaredTable(n.table, d),
          columns: this.list(n.columns, (c) => this.column(c, d), 16),
          unique: this.bool(n.unique),
          ifNotExists: this.bool(n.ifNotExists),
        })
      }
      case 'DropTableNode': {
        const n = this.node(value, kind, ['table', 'ifExists'], depth)
        return freeze({ kind, table: this.declaredTable(n.table, d), ifExists: this.bool(n.ifExists) })
      }
      case 'DropIndexNode': {
        const n = this.node(value, kind, ['name', 'table', 'ifExists'], depth)
        const schemable = this.node(n.name, 'SchemableIdentifierNode', ['identifier'], d)
        return freeze({
          kind,
          name: freeze({ kind: 'SchemableIdentifierNode', identifier: this.prefixedName(schemable.identifier, d + 1) }),
          table: n.table && this.declaredTable(n.table, d),
          ifExists: this.bool(n.ifExists),
        })
      }
      case 'AlterTableNode': {
        const n = this.node(value, kind, ['table', 'columnAlterations'], depth)
        return freeze({
          kind,
          table: this.declaredTable(n.table, d),
          columnAlterations: this.list(n.columnAlterations, (a) => this.columnAlteration(a, d), 16),
        })
      }
      default:
        this.fail('unsupported DDL')
    }
  }

  /** 索引名、约束名在不少数据库里是全局命名空间，统一加插件前缀。 */
  private prefixedName(value: unknown, depth: number) {
    return freeze({ kind: 'IdentifierNode', name: this.physical(this.identifier(value, depth).name) })
  }

  private columnDefinition(value: unknown, depth: number) {
    const n = this.node(
      value,
      'ColumnDefinitionNode',
      ['column', 'dataType', 'references', 'primaryKey', 'autoIncrement', 'unique', 'notNull', 'defaultTo'],
      depth,
    )
    const d = depth + 1
    const dataType = this.node(n.dataType, 'DataTypeNode', ['dataType'], d)
    if (
      typeof dataType.dataType !== 'string' ||
      !isColumnDataType(dataType.dataType) ||
      !DATA_TYPE.test(dataType.dataType)
    )
      this.fail(`data type ${JSON.stringify(dataType.dataType)} not allowed`)
    let defaultTo
    if (n.defaultTo !== undefined) {
      const dv = this.node(n.defaultTo, 'DefaultValueNode', ['defaultValue'], d)
      const v = this.node(dv.defaultValue, 'ValueNode', ['value', 'immediate'], d + 1)
      const ok =
        v.value === null ||
        typeof v.value === 'boolean' ||
        (typeof v.value === 'number' && Number.isFinite(v.value)) ||
        (typeof v.value === 'string' && SAFE_DEFAULT_STRING.test(v.value))
      if (!ok || v.immediate !== true) this.fail('invalid default value')
      defaultTo = freeze({
        kind: 'DefaultValueNode',
        defaultValue: freeze({ kind: 'ValueNode', value: v.value, immediate: true }),
      })
    }
    return freeze({
      kind: 'ColumnDefinitionNode',
      column: this.column(n.column, d),
      dataType: freeze({ kind: 'DataTypeNode', dataType: dataType.dataType }),
      references: n.references && this.references(n.references, d),
      primaryKey: this.bool(n.primaryKey),
      autoIncrement: this.bool(n.autoIncrement),
      unique: this.bool(n.unique),
      notNull: this.bool(n.notNull),
      defaultTo,
    })
  }

  private references(value: unknown, depth: number) {
    const n = this.node(value, 'ReferencesNode', ['table', 'columns', 'onDelete', 'onUpdate'], depth)
    for (const action of [n.onDelete, n.onUpdate])
      if (action !== undefined && !FK_ACTIONS.has(typeof action === 'string' ? action : ''))
        this.fail(`foreign key action ${typeof action === 'string' ? action : ''} not allowed`)
    return freeze({
      kind: 'ReferencesNode',
      // 外键只能指向本插件自己的表，否则会阻塞核心删除数据，也能探测核心表结构
      table: this.declaredTable(n.table, depth + 1),
      columns: this.list(n.columns, (c) => this.column(c, depth + 1), 8),
      onDelete: n.onDelete,
      onUpdate: n.onUpdate,
    })
  }

  private constraint(value: unknown, depth: number) {
    const kind = (value as N | null)?.kind
    const d = depth + 1
    switch (kind) {
      case 'PrimaryKeyConstraintNode':
      case 'UniqueConstraintNode': {
        const n = this.node(value, kind, ['columns', 'name'], depth)
        return freeze({
          kind,
          columns: this.list(n.columns, (c) => this.column(c, d), 8),
          name: n.name && this.prefixedName(n.name, d),
        })
      }
      case 'ForeignKeyConstraintNode': {
        const n = this.node(value, kind, ['columns', 'references', 'onDelete', 'onUpdate', 'name'], depth)
        for (const action of [n.onDelete, n.onUpdate])
          if (action !== undefined && !FK_ACTIONS.has(typeof action === 'string' ? action : ''))
            this.fail(`foreign key action ${typeof action === 'string' ? action : ''} not allowed`)
        return freeze({
          kind,
          columns: this.list(n.columns, (c) => this.column(c, d), 8),
          references: this.references(n.references, d),
          onDelete: n.onDelete,
          onUpdate: n.onUpdate,
          name: n.name && this.prefixedName(n.name, d),
        })
      }
      default:
        this.fail(`constraint ${String(kind)} not allowed`)
    }
  }

  private columnAlteration(value: unknown, depth: number) {
    const kind = (value as N | null)?.kind
    const d = depth + 1
    switch (kind) {
      case 'AddColumnNode': {
        const n = this.node(value, kind, ['column'], depth)
        return freeze({ kind, column: this.columnDefinition(n.column, d) })
      }
      case 'DropColumnNode': {
        const n = this.node(value, kind, ['column', 'ifExists'], depth)
        return freeze({ kind, column: this.column(n.column, d), ifExists: this.bool(n.ifExists) })
      }
      case 'RenameColumnNode': {
        const n = this.node(value, kind, ['column', 'renameTo'], depth)
        return freeze({ kind, column: this.column(n.column, d), renameTo: this.column(n.renameTo, d) })
      }
      default:
        this.fail(`column alteration ${String(kind)} not allowed`)
    }
  }
}

interface Ctx {
  inOnConflict?: boolean
  inOnDuplicateKey?: boolean
}

function freeze<const T extends object>(value: T): T {
  for (const key of Object.keys(value)) if ((value as N)[key] === undefined) delete (value as N)[key]
  return Object.freeze(value)
}
