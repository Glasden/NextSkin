import type { Rule } from 'eslint'
import { findQueryStart, memberName, unwrapChain, type Expression } from '../query-chain.ts'

const writeStarts = new Set(['updateTable', 'insertInto'])

// ESLint 只给监听器参数的类型补了 parent，递归读取的子节点没有这个字段。
type SyntaxNode<T = Rule.Node> = T extends Rule.Node ? Omit<T, 'parent'> : never

function usersQualifier(node: SyntaxNode | undefined): string | undefined {
  if (node?.type !== 'Literal' || typeof node.value !== 'string') return
  return /^users(?:\s+as\s+(\S+))?$/.exec(node.value)?.[1] ?? (node.value === 'users' ? 'users' : undefined)
}

function propertyName(node: SyntaxNode): string | undefined {
  // 计算属性和展开里的 score 有意不识别：不追踪动态键或展开来源。
  if (node.type !== 'Property' || node.computed) return
  if (node.key.type === 'Identifier') return node.key.name
  if (node.key.type === 'Literal' && typeof node.key.value === 'string') return node.key.value
}

function isScore(name: string | undefined, qualifier: string): boolean {
  return name === 'score' || name === `${qualifier}.score`
}

function isScoreLiteral(node: SyntaxNode | null | undefined, qualifier: string): boolean {
  return node?.type === 'Literal' && typeof node.value === 'string' && isScore(node.value, qualifier)
}

function hasScore(node: SyntaxNode | null | undefined, qualifier: string, arrays = false): boolean {
  if (node?.type === 'ArrowFunctionExpression') {
    if (node.body.type === 'BlockStatement') {
      return node.body.body.some(
        (statement) => statement.type === 'ReturnStatement' && hasScore(statement.argument, qualifier, arrays),
      )
    }
    return hasScore(node.body, qualifier, arrays)
  }
  if (arrays && node?.type === 'ArrayExpression') {
    return node.elements.some((element) => hasScore(element, qualifier))
  }
  return (
    node?.type === 'ObjectExpression' && node.properties.some((property) => isScore(propertyName(property), qualifier))
  )
}

function helperName(callee: Expression, node: Rule.Node, context: Rule.RuleContext): string | undefined {
  const identifier = callee.type === 'MemberExpression' ? unwrapChain(callee.object) : callee
  if (identifier.type !== 'Identifier') return
  // 按词法绑定确认导入来源，既支持导入别名，也避免误报被局部变量遮蔽的同名函数。
  const variable = context.sourceCode
    .getScope(node)
    .references.find((reference) => reference.identifier === identifier)?.resolved
  for (const definition of variable?.defs ?? []) {
    if (definition.type !== 'ImportBinding' || definition.parent.source.value !== '@nextskin/db') continue
    const specifier = definition.node
    if (callee.type === 'Identifier' && specifier.type === 'ImportSpecifier') {
      const name = specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value
      if (typeof name === 'string') return name
    }
    if (callee.type === 'MemberExpression' && specifier.type === 'ImportNamespaceSpecifier') return memberName(callee)
  }
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: '禁止绕过领域层的 adjustScore 直接写入用户积分' },
    schema: [],
    messages: {
      forbidden:
        '`users.score` 只能通过领域层的 `adjustScore` 修改，它在同一事务里原子地更新余额并写积分流水（ADR-0021，不变量 5）。',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = unwrapChain(node.callee)
        if (callee.type === 'MemberExpression') {
          const method = memberName(callee)
          if (method === 'set' || method === 'values') {
            const start = findQueryStart(callee.object, writeStarts)
            const qualifier = usersQualifier(start?.arguments[0])
            if (
              start &&
              qualifier &&
              memberName(unwrapChain(start.callee)) === (method === 'set' ? 'updateTable' : 'insertInto') &&
              (hasScore(node.arguments[0], qualifier, method === 'values') ||
                // Kysely 的 set(列名, 值) 重载
                (method === 'set' && isScoreLiteral(node.arguments[0], qualifier)))
            ) {
              context.report({ node, messageId: 'forbidden' })
            }
            return
          }
        }

        const qualifier = usersQualifier(node.arguments[1])
        if (!qualifier) return
        const helper = helperName(callee, node, context)
        const values = node.arguments[2]
        if ((helper === 'insertOrIgnore' || helper === 'insertReturningId') && hasScore(values, qualifier)) {
          context.report({ node, messageId: 'forbidden' })
        } else if (helper === 'upsert' && values?.type === 'ObjectExpression') {
          const writesScore = values.properties.some((property) => {
            if (property.type !== 'Property') return false
            const name = propertyName(property)
            if (name === 'values') return hasScore(property.value, qualifier, true)
            if (name !== 'update') return false
            const update = property.value
            return (
              hasScore(update, qualifier) ||
              (update.type === 'ArrayExpression' &&
                update.elements.some((element) => isScoreLiteral(element, qualifier)))
            )
          })
          if (writesScore) context.report({ node, messageId: 'forbidden' })
        }
      },
    }
  },
}

export default rule
