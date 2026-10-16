# ADR-0001 重写边界：Minecraft 协议严格兼容，网页 API 与插件 ABI 重新设计

- 状态：已采纳
- 日期：2026-10-16

## 背景

NextSkin 用 TypeScript 全栈重写 Blessing Skin Server（以下简称 BS）。BS 对外有三类接口，它们的兼容价值差别很大：

1. **Minecraft 客户端协议**：CustomSkinLoader、UniSkinMod、Legacy 直连、Yggdrasil（authlib-injector）。调用方是玩家电脑上的模组和启动器，以及游戏服务器，无法要求它们升级。
2. **网页端与 REST/OAuth API**：调用方是浏览器，以及少量第三方应用。
3. **插件 ABI**：PHP 的 `bootstrap.php`、Laravel 服务容器、Eloquent 模型、Twig 视图、Filter/Event。

## 决定

- 第 1 类**严格兼容**：路径、方法、状态码、响应结构、关键响应头（含 `X-Authlib-Injector-API-Location`）、缓存语义都和 BS v6 一致，由契约测试守护。
- 第 2 类**重新设计**：网页 URL 只保证旧链接可以 301 跳转（例如 `/skinlib/show/{tid}`）。REST/OAuth API 推出新版本，旧的 OAuth client 可以导入，但已签发的旧令牌全部作废，用户需要重新授权。
- 第 3 类**不兼容，也不做 PHP 兼容层**。改为提供迁移指南，并由官方迁移一批重要插件作为参考实现（见 ADR-0010）。

## 后果

- 研究报告里的 PHP sidecar、Laravel 与新系统并行逐路由切换、Passport 令牌共存、按 HTTP 方法改写路由，全部不需要做。
- 需要用一台真实的 BS v6 实例录制协议契约用例，作为第 1 类兼容性的唯一判据。
- 迁移指南必须在发布前写清楚"哪些不再兼容"，尤其是 OAuth 令牌作废。

## 考虑过的其他方案

- **原地兼容一切（含 PHP 插件）**：要在新系统旁边常驻一个 Laravel，等于同时维护两套系统，并且把旧插件的安全模型原样带进来。
- **连 Minecraft 协议也重新设计**：客户端无法跟进升级，不可行。
