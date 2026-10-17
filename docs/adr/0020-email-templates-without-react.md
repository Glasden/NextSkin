# ADR-0020 邮件模板不用 React，改用无依赖的 HTML 模板函数

- 状态：提议
- 日期：2026-10-18
- 取代 ADR-0012、ADR-0018 里"邮件模板用 react-email"这一条，两份 ADR 的其余部分不变

## 背景

ADR-0012 和 ADR-0018 定了邮件模板用 react-email 写。实现时发现走不通：

- 邮件在领域层渲染，领域层跑在 Next 进程里（ADR-0009），调用链是路由处理器 → Hono → 领域用例；
- Next 用服务端组件的模块条件（`react-server`）打包路由处理器。在这个条件下，react-dom 的所有服务端入口（`react-dom/server`、`server.node`、`server.edge`、`static`……）都指向一个只会报错的空壳；
- Turbopack 构建时直接报错："You're importing a component that imports react-dom/server"（2026-10-18 实测，Next 16.4.2、React 19.3.1）。

绕过去的办法都有明显的代价：
- 把 `@react-email/render` 列进 `serverExternalPackages`，由 Node 在运行时加载：它依赖 prettier、html-to-text，发行包多出几 MB；模板里的元素由 Next 自带的 React 创建，却交给 node_modules 里的另一份 react-dom 渲染，两份 React 混用；
- 放进 worker 线程渲染：Turbopack 怎么打包 worker 的模块条件不确定，还要多一条跨线程调用。

## 决定

- 邮件模板写成普通的 TS 函数，返回 `{ subject, html, text }`，不依赖 React 和任何渲染库。
- HTML 用一个 `html` 标签模板拼：插入的值默认按 HTML 转义，只有同一个辅助函数生成的片段原样插入。这样漏写转义的地方不会出现。
- 布局按邮件客户端的兼容写法手写：表格布局、内联样式、按钮用带底色的表格单元格（Outlook 也能显示），不用 CSS 变量、外部样式表和图片。
- 颜色仍取 `theme.css` 的亮色取值，测试核对两者一致（ADR-0018 的要求不变）。
- 文案仍走 `packages/i18n`（ADR-0019），纯文字版单独写，不从 HTML 转换。

## 后果

- 模板没有 JSX 写起来顺手。现在只有验证邮箱、重设密码两封邮件，结构简单；以后邮件多了，公共的布局和按钮也在同一个包里复用。
- 插件发邮件仍然只能通过核心（SDK 的 MailTransportProvider 只负责投递，内容由核心生成），插件不需要模板能力。
- 不再依赖 react-email，也就没有它的 Outlook 兼容处理；要靠手写的表格布局和人工检查几个主流客户端的显示效果。

## 考虑过的其他方案

- **`serverExternalPackages` 外置 `@react-email/render`**：一行配置能跑起来，但多了几 MB 依赖和两份 React 混用的隐患，见背景。
- **自己写一个输出字符串的 JSX 运行时（`jsxImportSource`）**：保留了 JSX，但等于维护一个小框架，打包器怎么解析它的路径也要单独验证，对两封邮件来说不值得。
- **在 worker 线程里用 React 渲染**：见背景。
