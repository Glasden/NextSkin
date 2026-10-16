import type { Rule } from 'eslint'

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: '禁止使用 Next.js 图片优化入口' },
    schema: [],
    messages: {
      forbidden:
        '不变量 8、ADR-0003：材质和用户上传的图片不能经过 next/image；请使用普通 img 元素，并保持 Image Optimization 关闭。',
    },
  },
  create(context) {
    return {
      'ImportDeclaration > Literal, ExportNamedDeclaration > Literal, ExportAllDeclaration > Literal, ImportExpression > Literal, CallExpression[callee.type="Identifier"][callee.name="require"] > Literal'(
        node: Rule.Node,
      ) {
        if (node.type !== 'Literal' || (node.value !== 'next/image' && node.value !== 'next/legacy/image')) return
        if (node.parent.type === 'CallExpression' && node.parent.arguments[0] !== node) return
        if (node.parent.type === 'ImportExpression' && node.parent.source !== node) return
        if ('source' in node.parent && node.parent.source !== node) return
        context.report({ node, messageId: 'forbidden' })
      },
    }
  },
}

export default rule
