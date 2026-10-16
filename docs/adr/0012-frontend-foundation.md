# ADR-0012 前端基座：token 单一来源 + Base UI + 自有组件库

- 状态：已采纳
- 日期：2026-10-16

## 背景

前端要做视觉性、产品化的重构，形成独特的视觉语言，并维护一套高质量组件和 DESIGN.md。视觉语言最常见的走样路径有三条：页面里随手写死颜色和间距；同一种控件出现多个版本；插件各自写界面。

## 决定

- **样式**：Tailwind CSS v4。`packages/ui/src/theme.css` 中 `@theme` 定义的语义 token 是**唯一来源**；DESIGN.md 里的 token 表由脚本从它生成，不手抄。
- **组件**：基础交互用无样式的 Base UI，外观自己写（React Aria Components 作为备选）。按 shadcn 那样"代码放进自己仓库维护"的方式管理，放在 `packages/ui`，但不沿用 shadcn 的外观。
- **其他依赖**：
  - 3D 皮肤预览：skinview3d（客户端组件，懒加载）；
  - 数据请求与表格：TanStack Query、TanStack Table；
  - URL 状态：nuqs；
  - 国际化：next-intl（ICU 消息格式），后台可在数据库中覆盖翻译；
  - 动效：以 CSS 为主，必要时用 Motion；
  - 邮件模板：react-email，使用同一套 token；
  - 图标：以 pixelarticons 为底，缺的再自己画。
- **强制机制**：
  - lint 禁止在 `packages/ui` 以外写原始色值、任意值类（`bg-[#…]`、`p-[13px]`）以及内联样式中的颜色；
  - 每个组件都有一份 Storybook story，同时作为交互测试；
  - Playwright 截图做视觉回归，亮色和暗色两种模式都要覆盖。
- **插件和邮件模板都只能用这套组件渲染**（ADR-0011）。

## 后果

- 新页面不能"先做出来再说"，缺少的组件要先在 `packages/ui` 里补齐。前期会慢一些，换来长期的一致性。
- DESIGN.md 的内容要和代码保持同步，token 部分靠生成脚本保证，组件清单靠 Storybook 保证。

## 考虑过的其他方案

- **直接用 shadcn/ui 的外观**：起步最快，但得到的正是要避免的"通用模板感"。
- **Radix UI 作为基础组件**：它的核心作者已经转去做 Base UI，Radix 后续的维护投入存疑。
