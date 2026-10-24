# NextSkin

[![CI](https://img.shields.io/github/actions/workflow/status/Glasden/NextSkin/ci.yml?branch=main&label=CI&logo=githubactions&logoColor=white)](https://github.com/Glasden/NextSkin/actions/workflows/ci.yml)
[![版本](https://img.shields.io/github/v/release/Glasden/NextSkin?label=%E7%89%88%E6%9C%AC)](https://github.com/Glasden/NextSkin/releases)
[![plugin-sdk](https://img.shields.io/npm/v/%40nextskin%2Fplugin-sdk/rc?label=plugin-sdk&logo=npm)](https://www.npmjs.com/package/@nextskin/plugin-sdk)
[![许可证](https://img.shields.io/github/license/Glasden/NextSkin?label=%E8%AE%B8%E5%8F%AF%E8%AF%81)](LICENSE)
<br>
[![Next.js](https://img.shields.io/badge/dynamic/yaml?url=https%3A%2F%2Fraw.githubusercontent.com%2FGlasden%2FNextSkin%2Fmain%2Fpnpm-workspace.yaml&query=%24.catalog.next&label=Next.js&logo=nextdotjs&color=black)](https://nextjs.org)
[![React](https://img.shields.io/badge/dynamic/yaml?url=https%3A%2F%2Fraw.githubusercontent.com%2FGlasden%2FNextSkin%2Fmain%2Fpnpm-workspace.yaml&query=%24.catalog.react&label=React&logo=react&logoColor=61DAFB&color=20232a)](https://react.dev)
[![Node.js](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FGlasden%2FNextSkin%2Fmain%2Fpackage.json&query=%24.engines.node&label=Node.js&logo=nodedotjs&logoColor=white&color=5FA04E)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)

用 TypeScript 重写的 [Blessing Skin Server](https://github.com/bs-community/blessing-skin-server)（BS）：Minecraft 皮肤站和外置登录（Yggdrasil）服务，给服主自己部署。

[文档](https://docs.nextskin.org) · [官网](https://nextskin.org) · [下载](https://github.com/Glasden/NextSkin/releases)

- **协议兼容**：CSL、USM、Legacy 和 Yggdrasil 的路径、状态码、响应与 BS v6 一致，玩家的模组和启动器不用换。以从真实 BS v6 录制的契约用例为准。
- **从 BS 迁移**：只读导入 BS 6 的库和材质，旧站不受影响，玩家 UUID 原样保留。
- **部署简单**：一个 zip，有 Node 24 就能运行，没有原生依赖、不需要 Redis。默认 SQLite，也支持 MySQL / MariaDB、PostgreSQL；另有 Docker 镜像。
- **一键升级**：站点每天读一份签过名的版本清单，有新版本时通知超级管理员。用发行包部署的在后台点一下就能升级：先下载、验签、对着在用的库预检，站点照常运行，再停站几秒到半分钟切换。新版本没起来就自动回到旧版本，SQLite 有迁移时连库一起换回升级前的自动备份；升级以后也能回滚到上一个版本。MySQL、PostgreSQL 有迁移时要先自己备份。
- **插件**：安装的插件跑在独立进程里，用到什么能力先声明。插件 SDK 发布在 npm（[`@nextskin/plugin-sdk`](packages/plugin-sdk)）；第三方登录、邀请码等官方插件随发行包分发。

还在 0.x，各版本的变化见 [Releases](https://github.com/Glasden/NextSkin/releases)，还没做完的部分见 [`docs/PROGRESS.md`](docs/PROGRESS.md)。

## 部署

从 [Releases](https://github.com/Glasden/NextSkin/releases) 下载 `nextskin-<版本>.zip`，解压后：

```bash
cd nextskin
node nextskin.mjs start
```

打开 `http://<服务器地址>:3000/setup` 建站，安装码在 `data/setup-code`。以后的版本在后台"更新"页一键升级，也可以把新的 zip 覆盖解压再启动。宝塔、1Panel、Docker、systemd、Windows 的步骤见 [`docs/deploy`](docs/deploy/README.md)，从 BS 迁移见 [`packages/importer/MIGRATION.md`](packages/importer/MIGRATION.md)。

## 开发

需要 Node 24+（推荐 26）、pnpm（`corepack enable` 按 `packageManager` 取）；数据库测试和截图回归还要 Docker。

```bash
corepack enable
pnpm install
pnpm --filter @nextskin/web exec playwright install chromium   # 单元测试和 story 测试跑在 Chromium 里
pnpm dev
```

打开 `http://localhost:3000/setup`，安装码在 `apps/web/data/setup-code`。默认用 SQLite，不依赖任何外部服务。

- 命令、目录、不变量和已知的坑：[`AGENTS.md`](AGENTS.md)。写给 agent，也是人读的开发约定。
- 提 PR 之前：读 [`docs/ci.md`](docs/ci.md)，按改动跑完对应的检查。什么改动直接进 main、什么改动走 PR，见 [ADR-0047](docs/adr/0047-branching.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [docs.nextskin.org](https://docs.nextskin.org) | 面向服主和玩家的使用文档、插件 API 参考 |
| [`docs/deploy/`](docs/deploy/README.md) | 部署：各种面板和运行方式、配置、反向代理 |
| [`packages/plugin-sdk/`](packages/plugin-sdk) | 插件开发 |
| [`AGENTS.md`](AGENTS.md) | 开发约定 |
| [`docs/ci.md`](docs/ci.md) | CI 与 PR 检查 |
| [`docs/adr/`](docs/adr/README.md) | 架构决策记录 |
| [`docs/schema.md`](docs/schema.md) | 核心表设计 |
| [`docs/DESIGN.md`](docs/DESIGN.md) | 视觉与界面规范 |
| [`docs/PROGRESS.md`](docs/PROGRESS.md) | 还没做完的部分 |

## 许可证

[MIT](LICENSE)
