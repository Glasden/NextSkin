# packages/ui

组件库和设计 token（ADR-0012、DESIGN.md）。新组件照 `src/button/` 的样子写：组件、story（同时是交互测试）、截图基线，再在 DESIGN.md §6 补一行。

## 写组件

- 组件不接受 `className` 和 `style`：外观只有组件自己定义的那几种，间距交给父元素。确实需要的布局变化做成属性，例如 Button 的 `fullWidth`。
- 交互部分包在 Base UI 外面。状态样式按 Base UI 设在元素上的 `data-*` 属性写（`data-disabled`、`data-invalid`、`data-checked`）：这些状态可能来自外层（Field 的 `disabled`），只看自己的 props 会漏。
- 用到 hook，或者给 Base UI 传函数（`render={(props, state) => …}`）的组件文件，开头写 `'use client'`。否则页面这个服务端组件引用它时，`next build` 会失败；Storybook 和单元测试发现不了。纯展示的组件不写，保持能在服务端渲染。
- 悬停统一是底色混入 12% 的 `text`（DESIGN.md §2），焦点框用 `src/styles.ts` 的 `focusRing`。

## story 和截图

- story 的 play 函数里用模拟点击时，结束前把焦点移开：模拟的点击会留下焦点框，真实的鼠标点击不会，截图会误导。
- 改了外观要更新基线：`pnpm test:visual -- --update-snapshots`，然后逐张看新截图，确认改动都是有意的。
- 截图按 `.storybook/preview.tsx` 里带 `data-screenshot` 的外框截取，正文字体也设在这一层：Storybook 给外层的 `.sb-wrapper` 设了自己的字体。
