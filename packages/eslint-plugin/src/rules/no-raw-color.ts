import type { Rule } from 'eslint'

const hexColor = /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i
const colorFunction = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(/i
const colorProperties = new Set([
  'color',
  'background',
  'backgroundColor',
  'backgroundImage',
  'border',
  'borderColor',
  'borderTop',
  'borderTopColor',
  'borderRight',
  'borderRightColor',
  'borderBottom',
  'borderBottomColor',
  'borderLeft',
  'borderLeftColor',
  'outline',
  'outlineColor',
  'fill',
  'stroke',
  'boxShadow',
  'textShadow',
  'caretColor',
  'accentColor',
  'textDecorationColor',
  'columnRuleColor',
])

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: '禁止原始色值和 JSX 内联颜色样式，统一使用语义 token' },
    schema: [],
    messages: {
      raw: '不变量 10、ADR-0012：颜色只能来自 packages/ui/src/theme.css 的语义 token，请使用对应的类。',
      style:
        '不变量 10、ADR-0012：JSX style 不能设置颜色相关属性，即使值来自变量；请使用 theme.css 中 token 对应的类。',
    },
  },
  create(context) {
    return {
      Literal(node) {
        if (typeof node.value === 'string' && colorFunction.test(node.value)) {
          context.report({ node, messageId: 'raw' })
        }
      },
      'Literal:not(JSXAttribute[name.name="href"] > Literal):not(JSXAttribute[name.name="href"] > JSXExpressionContainer > Literal)'(
        node: Rule.Node,
      ) {
        if (node.type === 'Literal' && typeof node.value === 'string' && hexColor.test(node.value.trim())) {
          context.report({ node, messageId: 'raw' })
        }
      },
      TemplateElement(node) {
        if (colorFunction.test(node.value.cooked ?? node.value.raw)) context.report({ node, messageId: 'raw' })
      },
      'JSXAttribute[name.name="style"] > JSXExpressionContainer > ObjectExpression > Property'(node: Rule.Node) {
        if (node.type !== 'Property') return
        const key = node.key
        const name = key.type === 'Identifier' && !node.computed ? key.name : key.type === 'Literal' ? key.value : null
        if (typeof name === 'string' && colorProperties.has(name)) context.report({ node, messageId: 'style' })
      },
    }
  },
}

export default rule
