import type { Rule } from 'eslint'

// rounded-md 只给面板和卡片用（DESIGN.md §3），页面里出现它就是在手拼面板；带变体前缀的（sm:rounded-md）也算
const panelRadius = /^(?:[\w-]+:)*!?rounded-md!?$/

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: '禁止在 packages/ui 以外手拼面板（rounded-md）' },
    schema: [],
    messages: {
      forbidden:
        'ADR-0058：页面里不手拼面板，用 packages/ui 的 Panel（或现成的卡片组件）；手拼的面板在主题改了结构时不会跟着带静止阴影。',
    },
  },
  create(context) {
    function check(node: Rule.Node, value: string) {
      if (value.split(/\s+/).some((token) => panelRadius.test(token))) context.report({ node, messageId: 'forbidden' })
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
