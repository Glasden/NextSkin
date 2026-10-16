import type { Rule } from 'eslint'

function isArbitraryClass(token: string): boolean {
  const parts: string[] = []
  let start = 0
  let depth = 0
  for (let index = 0; index < token.length; index++) {
    const character = token[index]
    if (character === '[' || character === '(') depth++
    if (character === ']' || character === ')') depth--
    if (depth < 0) return false
    if (character === ':' && depth === 0) {
      parts.push(token.slice(start, index))
      start = index + 1
    }
  }
  if (depth !== 0) return false
  const utility = token.slice(start)
  const arbitraryVariant = /^(?:[a-z][\w-]*-)?\[[^[\]]+\]$/i
  if (parts.some((part) => !/^[a-z][\w/-]*$/i.test(part) && !arbitraryVariant.test(part))) return false
  const ordinaryUtility = /^!?-?[a-z][\w-]*(?:\/[\w.-]+)?!?$/i
  const arbitraryUtility = /^!?-?[a-z][\w-]*-(?:\[[^[\]]+\]|\((?:[a-z-]+:)?--[\w-]+\))!?$/i
  const arbitraryProperty = /^!?\[[a-z-]+:[^[\]]+\]!?$/i
  // 只识别完整、常见的类名形态；罕见的嵌套括号语法留待有实际用例时扩展。
  return (
    arbitraryUtility.test(utility) ||
    arbitraryProperty.test(utility) ||
    (ordinaryUtility.test(utility) && parts.some((part) => arbitraryVariant.test(part)))
  )
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: '禁止 Tailwind 任意值、任意属性、任意变体和 CSS 变量简写' },
    schema: [],
    messages: {
      forbidden:
        '不变量 10、ADR-0012：不能使用 Tailwind 任意值类 {{className}}；请使用 packages/ui 的语义 token 和组件，缺少时先补 token、组件及 story。',
    },
  },
  create(context) {
    function check(node: Rule.Node, value: string) {
      for (const token of value.split(/\s+/)) {
        if (isArbitraryClass(token)) context.report({ node, messageId: 'forbidden', data: { className: token } })
      }
    }
    return {
      Literal(node) {
        if (typeof node.value === 'string') check(node, node.value)
      },
      TemplateElement(node) {
        check(node, node.value.cooked ?? node.value.raw)
      },
    }
  },
}

export default rule
