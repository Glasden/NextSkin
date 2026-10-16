import type { Rule } from 'eslint'

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: '禁止 Server Actions，写操作统一经过公开 API 和领域用例' },
    schema: [],
    messages: {
      forbidden: '不变量 4、ADR-0004：不用 Server Actions 写数据；请通过公开 API 调用领域用例。',
    },
  },
  create(context) {
    return {
      ExpressionStatement(node) {
        if ('directive' in node && node.directive === 'use server') context.report({ node, messageId: 'forbidden' })
      },
    }
  },
}

export default rule
