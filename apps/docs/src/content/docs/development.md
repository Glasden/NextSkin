---
title: 本地开发
description: 从仓库跑起 NextSkin，常用脚本、目录结构和提交约定。
sidebar:
  order: 1
---

## 准备

Node 24+、pnpm 12.8.1（`corepack enable` 会按 `packageManager` 取），以及 Docker（只有数据库测试和截图回归需要）。

```bash
corepack enable
pnpm install
# 单元测试和 story 测试跑在 Chromium 里
pnpm --filter @nextskin/web exec playwright install chromium
```

## 启动开发环境

```bash
pnpm dev
```

打开 `http://localhost:3000/setup`，安装码在 `apps/web/data/setup-code`。默认用 SQLite（`apps/web/data/nextskin.sqlite`），不依赖任何外部服务；空库要先建站，安装之前不能注册。环境变量见 [`packages/domain/src/config.ts`](https://github.com/Glasden/NextSkin/blob/main/packages/domain/src/config.ts)，也可以写进 `apps/web/.env`。

改了 `packages/api`、`packages/domain` 要重启 `pnpm dev`：核心和 Hono 应用缓存在 `globalThis` 上，热更新换不掉它们。

## 常用脚本

| 命令 | 用途 |
| --- | --- |
| `pnpm check` | lint + 类型检查 + 单元测试 + 格式检查，提交前必须通过 |
| `pnpm test <path>` | 只跑指定文件或目录的测试 |
| `pnpm test:db` | 在 SQLite / MySQL / MariaDB / PostgreSQL 上跑数据库测试（需要 Docker） |
| `pnpm test:contract` | 回放从真实 BS v6 录制的协议契约用例，不需要 Docker |
| `pnpm storybook` | 组件工作台 |
| `pnpm test:visual` | 组件截图回归（需要 Docker） |
| `pnpm build` | 构建 Next standalone 产物并组装发行目录 `dist/nextskin/` |
| `pnpm e2e` | 从 `dist/nextskin` 经启动器启动服务，跑 Playwright 端到端测试 |
| `pnpm test:pack` | 在仓库外安装 `pnpm pack` 出来的 SDK，类型检查并构建一个插件（要联网） |
| `pnpm format` | Prettier 格式化 |
| `pnpm design:sync` | 改了设计 token 或标志的图形后重新生成 DESIGN.md 的 token 表 |
| `pnpm nextskin <命令>` | 在源码里用启动器的命令行，读写 `apps/web` 的数据目录 |

## 改代码的固定顺序

- **新功能**：领域用例（含事务、拦截器、事件）→ Hono 路由与 zod schema → UI。文案先写进 `packages/i18n` 的 `zh-CN.json`，同时写 `en.json`。
- **新数据表**：迁移 → 类型 → 仓储，然后跑 `pnpm test:db`。
- **新组件**：写进 `packages/ui`，按 `src/button/` 的样子配 story 和截图基线，并在 DESIGN.md 的组件清单里补一行。
- **新的或改动的协议行为**：先在 `tests/contract/src/cases.ts` 加用例、从 BS v6 录制，再实现。
- **新设置项**：在设置注册表里声明类型、默认值和分区，后台表单会自动生成，不要手写表单。

更细的约定和“已知的坑”见 [AGENTS.md](https://github.com/Glasden/NextSkin/blob/main/AGENTS.md)。

## 目录结构

```
nextskin 启动器（进程监管 + 命令行）
 └─ 核心进程：Next.js（页面）+ Hono（协议端点 / REST / 插件路由）+ 领域层 + 后台任务
     ├─ Kysely → SQLite | MySQL/MariaDB | PostgreSQL
     └─ plugin host 进程（运行安装的插件，通过 RPC 调用核心）
```

| 路径 | 内容 |
| --- | --- |
| `apps/web` | Next.js 页面，只做 UI |
| `packages/api` | Hono 应用：协议端点、REST API、插件路由网关 |
| `packages/domain` | 领域用例与查询服务，按业务领域分目录 |
| `packages/db` | Kysely 实例、迁移、方言辅助函数 |
| `packages/ui` | 组件库与设计 token |
| `packages/skin` | 材质的前处理和出图 |
| `packages/launcher` | 启动器 `nextskin` 和发行目录的组装 |
| `packages/plugin-sdk`、`plugin-host`、`plugin-cli` | 插件公开 API、运行时和构建命令 |
| `packages/importer` | 从 BS v6 只读导入 |
| `plugins/*` | 官方插件 |
| `tests/contract` | 协议契约用例 |
| `docs/` | ADR、表设计、部署文档 |

## 提交、分支和发布

- 文档和单提交的修复直接进 `main`；加迁移、改协议端点或 SDK 公开 API、要分几个提交的功能，开 `feat/` 或 `fix/` 分支提 PR，CI 通过后由维护者合并（[ADR-0047](https://github.com/Glasden/NextSkin/blob/main/docs/adr/0047-branching.md)）。
- CI 跑 `pnpm check`、`test:db`、`e2e`；改了数据库代码或 Next 配置时先在本地跑。
- 插件 SDK 的公开 API 一旦变化必须附 changeset，并通过 `packages/plugin-sdk/type-tests`。
