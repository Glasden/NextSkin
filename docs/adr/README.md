# 架构决策记录（ADR）

每份 ADR 记录一个已经做出的决定：为什么这么选、放弃了什么、带来什么后果。它们存在的意义是让人和 agent 不再反复推翻已经论证过的结论。

## 规则

- ADR 一经采纳就不再修改正文。要改变决定，就新写一份 ADR，并把旧的状态改为"已被 ADR-xxxx 取代"。
- 状态只有四种：**提议**、**已采纳**、**待验证**（依赖下面的某个 spike）、**已被取代**。
- 部分 ADR 的背景里提到的"研究报告"，指项目启动时的两份可行性研究报告（"研判报告"与"研讨报告"）。它们已于 2026-10-16 删除，有价值的结论都已吸收进 ADR。

## 索引

| 编号 | 决定 | 状态 |
|---|---|---|
| [0001](0001-rewrite-boundary.md) | 重写边界：Minecraft 协议严格兼容，网页 API 与插件 ABI 重新设计 | 已采纳 |
| [0002](0002-deployment-baseline.md) | 部署基线：单进程、单数据库起步，Redis/S3/容器为可选档位 | 已采纳 |
| [0003](0003-next-as-ui-shell.md) | Next.js 只做 UI 壳，HTTP 契约层用 Hono | 已采纳 |
| [0004](0004-single-write-path.md) | 写操作唯一入口：领域用例；Web UI 走公开 API | 已采纳 |
| [0005](0005-kysely-three-dialects.md) | 数据访问用 Kysely，支持 SQLite / MySQL / PostgreSQL | 已采纳 |
| [0006](0006-new-schema-and-importer.md) | 新 schema + 只读导入器，不沿用旧表结构 | 已采纳 |
| [0007](0007-auth.md) | 认证：Better Auth + 自写 Yggdrasil 令牌体系 | 已采纳（S1 通过） |
| [0008](0008-zero-native-deps.md) | 零原生依赖：node:sqlite + 纯 TS/WASM 图像管线 | 已采纳（S2、S4 通过） |
| [0009](0009-plugin-runtime.md) | 插件运行模型：官方插件在核心进程内，安装插件在 plugin host，整代切换 | 已采纳 |
| [0010](0010-plugin-api.md) | 插件 API：声明式定义、六类扩展点、能力授权、独立版本 | 已采纳（S5 通过） |
| [0011](0011-plugin-ui.md) | 插件 UI：声明式为默认，运行时组件共享宿主 React | 已采纳（S3 通过） |
| [0012](0012-frontend-foundation.md) | 前端基座：token 单一来源 + Base UI + 自有组件库 | 已采纳（react-email 一条已被 ADR-0020 取代） |
| [0013](0013-version-baseline.md) | 版本基线：Node 26 LTS、Next.js ≥16.4.1、TypeScript 7 | 已采纳 |
| [0014](0014-toolchain.md) | 工具链：pnpm + Turborepo，TypeScript 7 做类型检查（TS 6 只给依赖编译器 API 的工具），ESLint、Prettier、Vitest、changesets | 已采纳 |
| [0015](0015-core-schema-conventions.md) | 核心 schema 约定：时间存 ISO 字符串、角色名靠规范化列、UUID 绑定角色；逐表设计见 `docs/schema.md` | 已采纳 |
| [0016](0016-protocol-contract.md) | 协议契约以录制结果为判据；客户端可能依赖的 BS 行为照样复现，只有异常输入才触发的 Laravel/PHP 副产品不复现 | 已采纳 |
| [0017](0017-skin-figure-rendering.md) | 皮肤的 2D 正背面由服务端出图，按显示倍数选分辨率，浏览器只做整数倍放大 | 已采纳 |
| [0018](0018-registration-and-mail.md) | 注册走领域用例，规则和默认值取 BS；邮件在事务之外异步发送 | 已采纳（react-email 一条已被 ADR-0020 取代） |
| [0019](0019-i18n.md) | 国际化：URL 不带语言前缀，消息集中在 `packages/i18n`，接口错误带 code 和本地化文案 | 已采纳 |
| [0020](0020-email-templates-without-react.md) | 邮件模板不用 React，改用无依赖的 HTML 模板函数（取代 ADR-0012、ADR-0018 里 react-email 的部分） | 已采纳 |
| [0021](0021-events-and-jobs.md) | 事件和后台任务共用数据库里的一张任务表，事件在业务事务里按订阅者展开成任务；积分只经过 `adjustScore` 修改（取代 ADR-0002 里队列的 Redis 驱动、ADR-0018 里进程内的邮件队列） | 提议 |

## 待做的 spike

每一项都有现成的退路，失败也不会动摇整体架构。

| 编号 | 要验证什么 | 不通过时的退路 | 状态 |
|---|---|---|---|
| S1 | Better Auth 的 `@better-auth/oauth-provider` 加设备授权插件，能否同时承载第三方 OAuth 应用和 Yggdrasil Connect；能否映射到整数 uid 的用户表 | Better Auth 只管网页登录，OAuth/OIDC 服务端单独实现 | ✅ 通过，见 `spikes/s1-better-auth/` |
| S2 | Kysely 用 `node:sqlite` 驱动：功能、事务、并发写入表现 | better-sqlite3（原生依赖，需要按平台打包） | ✅ 通过；自写方言，一写一读两个连接，插件查询走专用 worker，见 `spikes/s2-node-sqlite/` |
| S3 | 运行时加载的插件前端组件，通过 import map + shim 共享 Next 内置的那份 React | 安装插件只允许声明式 UI | ✅ 通过；integrity 只能写在 import map 里，import map 之前不能有 modulepreload，CSP 约束不了插件代码，见 `spikes/s3-plugin-ui/` |
| S4 | 纯 TS/WASM 图像管线：解码与编码性能、2D 头像和 3D 预览的效果 | sharp | ✅ 通过；新材质改用像素 hash，见 `spikes/s4-image-pipeline/` |
| S5 | 远程 Kysely 驱动：校验操作节点树、表名映射、事务内执行 | 安装插件只提供 KV 存储，自有表仅限官方插件 | ✅ 通过，有遗留的 SQLite 风险，见 `spikes/s5-remote-kysely/` |

## 模板

```markdown
# ADR-NNNN 标题

- 状态：提议 / 已采纳 / 待验证（Sx）/ 已被 ADR-xxxx 取代
- 日期：YYYY-MM-DD

## 背景
## 决定
## 后果
## 考虑过的其他方案
```
