import type { Rule } from 'eslint'

const publicPrefix = ['NEXT', 'PUBLIC', ''].join('_')

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: '禁止把站点配置写入构建时的公开环境变量' },
    schema: [],
    messages: {
      forbidden: `不变量 7：同一份构建产物要分发给所有服主，不能使用 ${publicPrefix}*；请从数据库读取站点配置。`,
    },
  },
  create(context) {
    return {
      Identifier(node) {
        if (node.name.startsWith(publicPrefix)) context.report({ node, messageId: 'forbidden' })
      },
      Literal(node) {
        if (typeof node.value === 'string' && node.value.includes(publicPrefix)) {
          context.report({ node, messageId: 'forbidden' })
        }
      },
      TemplateElement(node) {
        if ((node.value.cooked ?? node.value.raw).includes(publicPrefix)) {
          context.report({ node, messageId: 'forbidden' })
        }
      },
    }
  },
}

export default rule
