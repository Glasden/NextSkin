# ADR-0003 Next.js 只做 UI 壳，HTTP 契约层用 Hono

- 状态：已采纳
- 日期：2026-10-16

## 背景

系统里相当一部分是纯 HTTP 契约：Minecraft 协议端点、REST/OAuth API、插件路由。用 Next.js 的 Route Handler 直接承载它们有几个问题：

- Next 的路由树在构建时就已固定，插件路由无法在运行时注册；
- 同一路由段不能同时有 `page.tsx` 和 `route.ts`；
- 测试必须连同 Next 一起启动；
- 框架升级频繁，且 2025–2026 年接连出现严重安全问题（最近一次是 2026-10-14 修复的 Image Optimization 未授权 RCE）。

## 决定

- Next.js（App Router）只负责页面：服务端组件读数据时直接调用领域层（ADR-0004），客户端组件通过 API 写数据。
- 所有非页面的 HTTP 端点用 **Hono** 实现，以 catch-all Route Handler 挂进 Next，与 Next 运行在同一进程，不需要额外端口和反向代理。
- 根路径上的协议端点（`/{player}.json`、`/csl/*`、`/usm/*`、`/textures/*`、`/skin/*.png`、`/cape/*.png`、`/api/yggdrasil/*` 等）用 rewrite 转入 Hono。
- 用 `@hono/zod-openapi` 生成 OpenAPI 文档和带类型的客户端。
- 对 Next 的约束：
  - 关闭 Image Optimization（`images.unoptimized: true`），并在反向代理层屏蔽 `/_next/image`；材质永远不经过 `next/image`；
  - 不把 Server Actions 当成对外契约；
  - 不依赖 Next 的数据缓存和 ISR 做业务缓存，因为它们在多实例部署和插件触发的失效场景下难以推理；
  - `output: 'standalone'`。

## 后果

- 协议与 API 的契约测试可以直接调用 `app.request()`，不用启动 Next，速度快、结果确定。
- 插件路由可以在运行时动态注册（`/plugins/{id}/*`）。
- 将来要更换前端框架，只需要替换 UI 这一层壳。
- 需要维护一份 rewrite 规则，且必须有测试保证它和协议路径清单一致。

## 考虑过的其他方案

- **全部用 Next Route Handler**：存在上面列出的全部问题。
- **自定义服务器（Hono 作为入口，再挂 Next 的请求处理器）**：脱离了 standalone 产物的常规路径，每次升级 Next 都可能出问题。
- **改用 React Router 7 或 TanStack Start**：可行，但收益不足以抵消生态成熟度和团队熟悉度上的损失。如果将来 Next 的维护成本失控，这是首选替代。
