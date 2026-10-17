import type { Rule } from 'eslint'

export type Expression = Extract<Rule.Node, { type: 'MemberExpression' }>['object']

// 计算属性有意不识别，避免把动态成员名猜成 SQL 方法。
export function memberName(node: Expression): string | undefined {
  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
    return node.property.name
  }
}

export function unwrapChain(node: Expression): Expression {
  return node.type === 'ChainExpression' ? unwrapChain(node.expression) : node
}

export function findQueryStart(
  node: Expression,
  starts: ReadonlySet<string>,
): Extract<Expression, { type: 'CallExpression' }> | undefined {
  while (true) {
    node = unwrapChain(node)
    if (node.type === 'CallExpression') {
      const callee = unwrapChain(node.callee)
      if (callee.type !== 'MemberExpression') return
      if (starts.has(memberName(callee) ?? '')) return node
      node = callee.object
    } else if (node.type === 'MemberExpression') {
      node = node.object
    } else {
      return
    }
  }
}
