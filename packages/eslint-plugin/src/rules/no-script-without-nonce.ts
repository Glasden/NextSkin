import type { Rule } from 'eslint'

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: '禁止 JSX 内建 script 元素缺少显式 nonce 属性' },
    schema: [],
    messages: {
      forbidden:
        "ADR-0053：页面的 CSP 只执行带本次请求 nonce 的脚本，不带 nonce 的 <script> 会被浏览器拦下；请显式添加 nonce 属性，服务端组件用 (await headers()).get('x-nonce') 读取，客户端组件从 props 传入。",
    },
  },
  create(context) {
    return {
      'JSXOpeningElement[name.type="JSXIdentifier"][name.name="script"]:not(:has(> JSXAttribute[name.type="JSXIdentifier"][name.name="nonce"]))'(
        node: Rule.Node,
      ) {
        context.report({ node, messageId: 'forbidden' })
      },
    }
  },
}

export default rule
