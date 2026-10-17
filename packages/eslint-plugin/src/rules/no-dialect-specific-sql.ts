import type { Rule } from 'eslint'

type Expression = Extract<Rule.Node, { type: 'MemberExpression' }>['object']

// 计算属性有意不识别，避免把动态成员名猜成 SQL 方法。
function memberName(node: Expression): string | undefined {
  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
    return node.property.name
  }
}

function unwrapChain(node: Expression): Expression {
  return node.type === 'ChainExpression' ? unwrapChain(node.expression) : node
}

const queryStarts = new Set([
  'selectFrom',
  'selectNoFrom',
  'insertInto',
  'updateTable',
  'deleteFrom',
  'replaceInto',
  'mergeInto',
])

function hasQueryStart(node: Expression): boolean {
  while (true) {
    node = unwrapChain(node)
    if (node.type === 'CallExpression') {
      const callee = unwrapChain(node.callee)
      if (callee.type !== 'MemberExpression') return false
      if (queryStarts.has(memberName(callee) ?? '')) return true
      node = callee.object
    } else if (node.type === 'MemberExpression') {
      node = node.object
    } else {
      return false
    }
  }
}

function isColumnDefinition(node: Rule.Node, object: Expression, context: Rule.RuleContext): boolean {
  let root = unwrapChain(object)
  while (root.type === 'CallExpression') {
    const callee = unwrapChain(root.callee)
    if (callee.type !== 'MemberExpression') return false
    root = unwrapChain(callee.object)
  }
  if (root.type !== 'Identifier') return false
  // 用 ESLint 的词法绑定确认接收者，避免嵌套作用域里的同名对象被误认成列。
  const variable = context.sourceCode
    .getScope(node)
    .references.find((reference) => reference.identifier === root)?.resolved
  const definition = variable?.defs.find((definition) => definition.type === 'Parameter')
  if (!definition || definition.type !== 'Parameter') return false
  const callback = definition.node
  if (callback.type !== 'ArrowFunctionExpression' && callback.type !== 'FunctionExpression') return false
  if (callback.params[0] !== definition.name) return false
  const call = context.sourceCode.getAncestors(callback).at(-1)
  if (call?.type !== 'CallExpression' || call.arguments[2] !== callback) return false
  const method = memberName(unwrapChain(call.callee))
  return method === 'addColumn' || method === 'modifyColumn'
}

const uniqueMethods = new Map([
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
])

const queryMethods = new Map([
  ['returning', 'returning'],
  ['ignore', 'ignore'],
  ['top', 'top'],
  ['output', 'output'],
  ['skipLocked', 'lockOption'],
  ['noWait', 'lockOption'],
])

const aggregates = new Set(['count', 'countAll', 'countDistinct', 'sum', 'avg'])

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: '禁止绕过 packages/db 辅助函数使用方言专属 SQL 或假定聚合返回类型' },
    schema: [],
    messages: {
      references:
        'ADR-0015：MySQL 会忽略列定义里的 references，导致外键未生效；建表时请用 addForeignKeyConstraint，给已有表加列时请用 packages/db 的 addForeignKeyColumn(db, options)。',
      conflict:
        '不变量 6：MySQL/MariaDB 不支持 onConflict；请用 packages/db 的 insertOrIgnore(db, table, values, conflictColumns) 或 upsert(db, table, { values, conflict, update })。',
      upsert:
        '不变量 6：SQLite/PostgreSQL 不支持 onDuplicateKeyUpdate；请用 packages/db 的 upsert(db, table, { values, conflict, update })。',
      ignore:
        '不变量 6：ignore 是 MySQL/MariaDB 语法，SQLite/PostgreSQL 不支持；请用 packages/db 的 insertOrIgnore(db, table, values, conflictColumns)。',
      orIgnore:
        '不变量 6：orIgnore 是 SQLite 语法，MySQL/MariaDB/PostgreSQL 不支持；请用 packages/db 的 insertOrIgnore(db, table, values, conflictColumns)。',
      replace:
        '不变量 6：PostgreSQL 不支持 REPLACE，且它会删除旧行再插入，可能破坏关联数据；请用 packages/db 的 upsert(db, table, { values, conflict, update })，确需替换语义时在 packages/db 补辅助函数。',
      sqliteConflict:
        '不变量 6：OR ABORT/FAIL/ROLLBACK 是 SQLite 专属冲突策略，其他数据库不支持；冲突写入请用 packages/db 的 insertOrIgnore 或 upsert，确需其他策略时在 packages/db 补辅助函数。',
      returning:
        '不变量 6：MySQL 不支持 returning；获取插入 id 请用 packages/db 的 insertReturningId(db, table, values, idColumn?)，其他返回字段另行查询。',
      returningAll:
        '不变量 6：MySQL 不支持 returningAll；获取插入 id 请用 packages/db 的 insertReturningId(db, table, values, idColumn?)，其他返回字段另行查询。',
      merge:
        '不变量 6：SQLite/MySQL/MariaDB 不支持 MERGE；请用 packages/db 的 upsert(db, table, { values, conflict, update })。',
      distinctOn:
        '不变量 6：DISTINCT ON 是 PostgreSQL 专属语法，SQLite/MySQL/MariaDB 不支持；请改用通用的分组查询，确需此功能时在 packages/db 补辅助函数。',
      autoIncrement:
        '不变量 6：autoIncrement 和 identity 的语法及支持情况随数据库而变，PostgreSQL 不支持 AUTO_INCREMENT，SQLite 不支持 identity；请用 packages/db 的 autoIncrementId(db, column?)。',
      rowLock:
        '不变量 6：SQLite 不支持这些行锁；请改用条件更新（update … set n = n - 1 where n >= 1），确需行锁时在 packages/db 补辅助函数。',
      lockOption:
        '不变量 6：SQLite 不支持 skipLocked/noWait 锁等待选项；请改用条件更新（update … set n = n - 1 where n >= 1），确需此功能时在 packages/db 补辅助函数。',
      top: '不变量 6：TOP 是 SQL Server 语法，SQLite/MySQL/MariaDB/PostgreSQL 不支持；请用 limit，确需方言差异处理时在 packages/db 补辅助函数。',
      output:
        '不变量 6：OUTPUT 是 SQL Server 语法，SQLite/MySQL/MariaDB/PostgreSQL 不支持；获取插入 id 请用 packages/db 的 insertReturningId(db, table, values, idColumn?)，其他返回字段另行查询。',
      createTable:
        '不变量 6：直接 schema.createTable 会绕过 MySQL/MariaDB 统一的引擎、字符集和排序规则，导致存储及比较行为不一致；请用 packages/db 的 createTable(db, name)。',
      serial:
        '不变量 6：serial/bigserial/smallserial 是 PostgreSQL 自增类型，SQLite 不会按此生成自增 id，MySQL/MariaDB 的类型及支持情况也不同；请用 packages/db 的 autoIncrementId(db, column?)。',
      aggregateType:
        '不变量 6：聚合的类型参数只会掩盖真实返回类型，PostgreSQL 的 count 返回字符串，其他聚合也可能返回 string/number/bigint；请移除类型参数，用 packages/db 的 countRows(query) 或 toNumber(value) 转换结果。',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = unwrapChain(node.callee)
        if (callee.type !== 'MemberExpression') return
        const name = memberName(callee)
        if (!name) return
        const object = unwrapChain(callee.object)

        const messageId = uniqueMethods.get(name) ?? (hasQueryStart(object) ? queryMethods.get(name) : undefined)
        if (messageId) {
          context.report({ node, messageId })
        } else if (name === 'references' && isColumnDefinition(node, object, context)) {
          context.report({ node, messageId: 'references' })
        } else if (name === 'createTable' && memberName(object) === 'schema') {
          context.report({ node, messageId: 'createTable' })
        } else if (name === 'addColumn' || name === 'modifyColumn') {
          const type = node.arguments[1]
          if (
            type?.type === 'Literal' &&
            typeof type.value === 'string' &&
            /^(serial|bigserial|smallserial)$/i.test(type.value)
          ) {
            context.report({ node, messageId: 'serial' })
          }
        } else if (
          aggregates.has(name) &&
          ((object.type === 'Identifier' && object.name === 'fn') || memberName(object) === 'fn') &&
          'typeArguments' in node &&
          node.typeArguments
        ) {
          context.report({ node, messageId: 'aggregateType' })
        }
      },
    }
  },
}

export default rule
