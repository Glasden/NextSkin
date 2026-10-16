import type { Rule } from 'eslint'

const linkRel = 'JSXOpeningElement[name.type="JSXIdentifier"][name.name="link"] > JSXAttribute[name.name="rel"]'

function staticString(node: {
  type: string
  value?: unknown
  expressions?: readonly unknown[]
  quasis?: readonly { value: { cooked?: string | null; raw: string } }[]
}): string | undefined {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node.type === 'TemplateLiteral' && node.expressions?.length === 0) {
    const value = node.quasis?.[0]?.value
    return value?.cooked ?? value?.raw
  }
  return undefined
}

function isModulepreload(value: string | undefined): boolean {
  return value?.toLowerCase().split(/\s+/).includes('modulepreload') ?? false
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: '禁止渲染会排在 import map 之前的 modulepreload link' },
    schema: [],
    messages: {
      forbidden:
        'ADR-0011：React 19 会把 link 提到 head 最前面、排在 import map 之前，Firefox 因此丢弃整个 import map，Chromium 跳过 integrity；请改用 ReactDOM.preloadModule()。',
    },
  },
  create(context) {
    return {
      [`${linkRel} > Literal, ${linkRel} > JSXExpressionContainer > :matches(Literal, TemplateLiteral)`](
        node: Rule.Node,
      ) {
        if (isModulepreload(staticString(node))) context.report({ node, messageId: 'forbidden' })
      },
      CallExpression(node) {
        const callee = node.callee
        const isCreateElement =
          (callee.type === 'Identifier' && callee.name === 'createElement') ||
          (callee.type === 'MemberExpression' &&
            ((!callee.computed && callee.property.type === 'Identifier' && callee.property.name === 'createElement') ||
              (callee.computed && callee.property.type === 'Literal' && callee.property.value === 'createElement')))
        const [tag, props] = node.arguments
        if (!isCreateElement || !tag || staticString(tag) !== 'link' || props?.type !== 'ObjectExpression') return
        for (const property of props.properties) {
          if (property.type !== 'Property') continue
          const key = property.key
          const name = key.type === 'Identifier' && !property.computed ? key.name : staticString(key)
          if (name === 'rel' && isModulepreload(staticString(property.value))) {
            context.report({ node: property, messageId: 'forbidden' })
          }
        }
      },
    }
  },
}

export default rule
