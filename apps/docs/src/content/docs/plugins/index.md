---
title: 插件开发总览
description: 用 @nextskin/plugin-sdk 扩展 NextSkin。
sidebar:
  order: 1
---

NextSkin 的插件运行在独立的 host 进程里：通过 RPC 调用核心，拿不到数据库凭据；只使用公开 API 的插件可以在站点升级后继续工作。

## 能做什么

- 新协议端点与 REST 接口
- 后台设置项、页面和材质处理钩子
- 监听事件、拦截领域用例
- 自己的数据表、后台任务和外部服务对接

## 从哪里开始

- [入门](/plugins/reference/getting-started/)：建项目、装 SDK、跑起第一个插件
- [上下文](/plugins/reference/context/)：插件拿到的 `ctx` 里有什么
- [路由](/plugins/reference/routes/)、[界面](/plugins/reference/ui/)、[设置](/plugins/reference/settings/)
- [数据表](/plugins/reference/tables/)、[事件](/plugins/reference/events/)、[后台任务](/plugins/reference/jobs/)
- [拦截点](/plugins/reference/interceptors/)、[安全](/plugins/reference/security/)

## 版本

这份参考文档在构建时从同一版本的 `packages/plugin-sdk/docs` 生成，侧栏的分组上标着对应的 SDK 版本。SDK 还在 1.0 候选期，接口可能调整；已发布的版本以 npm 上的 `@nextskin/plugin-sdk` 为准。
