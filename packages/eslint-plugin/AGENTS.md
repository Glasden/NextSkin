# packages/eslint-plugin

把 AGENTS.md 里能机械检查的不变量写成 lint 规则（ADR-0014）。根目录的 `eslint.config.js` 启用 `configs.recommended`，按目录的豁免也写在那里，规则本身不感知目录。

## 加一条规则

1. `src/rules/<名字>.ts` 写规则，`<名字>.test.ts` 写正反例（RuleTester 接 Vitest，见 `src/rule-tester.ts`）。在 `src/index.ts` 注册后自动进入 `recommended`。
2. 报错消息写清为什么不行、该怎么做，并注明出处（不变量编号或 ADR）。读到报错的 agent 不应需要再翻文档。
3. 宁可漏报，不要误报：误报多了，大家就会到处写 `eslint-disable`。
4. 规则落地后，删掉 AGENTS.md 里对应的说明文字，只在不变量那一条留下"守护：lint"。

插件不编译，由 Node 的类型剥离直接加载：相对导入要写 `.ts` 扩展名，只能用可擦除的 TS 语法。
