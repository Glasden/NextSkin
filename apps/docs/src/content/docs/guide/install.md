---
title: 安装部署
description: 用发行包或 Docker 部署 NextSkin，配好反向代理和环境变量，需要时升级或回退。
sidebar:
  order: 2
---

NextSkin 只需要 Node 和一个可写的数据目录：默认用 SQLite，不需要 Redis、消息队列或 pm2。管理进程负责选版本和升级，启动器负责监管核心进程，插件在独立的 host 进程里跑。

## 环境要求

| 用途 | 要求 |
| --- | --- |
| 运行发行包 | Node 24 或更新，推荐 26（24、25 上 plugin host 拦不住插件绕过站点直接连网，`start` 和 `doctor` 会提示） |
| Docker | 没有额外要求，镜像自带运行时 |
| 开发 | Node 24+、pnpm 12.8.1（`corepack enable` 会按 `packageManager` 取） |
| 跑数据库测试、截图回归 | Docker |

## 发行包

1. 从 [GitHub Releases](https://github.com/Glasden/NextSkin/releases) 下载 `nextskin-<版本>.zip` 和同一页的 `SHA256SUMS`，核对：

   ```bash
   sha256sum -c SHA256SUMS
   ```

   正式版还附带 `SHA256SUMS.sig`：发布时用 NextSkin 的发布私钥对 `SHA256SUMS` 签的名，站点自己检查更新、下载升级包时也认这把钥匙。要确认 `SHA256SUMS` 本身没被换过，下载[发布公钥](/release-keys/2026-10.pem)，用 OpenSSL 3 核对：

   ```bash
   openssl pkeyutl -verify -pubin -inkey 2026-10.pem -rawin -in SHA256SUMS -sigfile SHA256SUMS.sig
   ```

2. 解压并启动。包里不带 Node，也不需要 `npm install`：

   ```bash
   unzip nextskin-<版本>.zip -d /opt
   cd /opt/nextskin
   node nextskin.mjs start
   ```

   第一次启动会生成 `.env`（权限 600，里面是 `NEXTSKIN_SECRET`），**备份它**。丢了它，后台保存的机密设置要重填。

3. 打开 `http://<服务器地址>:3000/setup` 建站。安装码在数据目录的 `setup-code` 文件里：

   ```bash
   cat data/setup-code
   ```

   建好站后这个文件被删除，`/setup` 返回 404。“站点地址”填玩家实际访问的地址，例如 `https://skin.example.com`。

4. 生产环境放在反向代理后面，见下一节。

发行目录里的 `data/` 是数据目录：SQLite 库、材质、插件、备份和 `setup-code` 都在里面，运行用户要能写。程序在 `releases/<版本>/` 里，`releases/current.json` 指向在用的版本。

## 反向代理

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 12m;
}
```

- `Host` 要和玩家请求里的一致，`X-Forwarded-Proto` 决定协议端点算出来的站点地址。
- `client_max_body_size` 至少 12 MB：材质上传和插件包都走这个入口。
- 反向代理不在同一个网络命名空间里时（Docker、1Panel、另一台机器），还要把网关地址加进后台“设置 → 高级 → 受信任的反向代理”，否则客户端 IP 会识别错。

## Docker

镜像 `ghcr.io/glasden/nextskin`，支持 linux/amd64 和 linux/arm64。用仓库里的 [compose.yaml](https://github.com/Glasden/NextSkin/blob/main/docs/deploy/compose.yaml)：

```bash
echo "NEXTSKIN_SECRET=$(openssl rand -hex 32)" > .env && chmod 600 .env
curl -fsSLO https://raw.githubusercontent.com/Glasden/NextSkin/main/docs/deploy/compose.yaml
docker compose up -d
docker compose exec nextskin cat /data/setup-code
```

- `.env` 不在数据卷里，要另外备份；容器里没有 `.env`，`NEXTSKIN_SECRET` 必须由环境变量给出。
- 数据卷挂在 `/data`，备份它和 `.env` 就够。
- 细节见 [docker.md](https://github.com/Glasden/NextSkin/blob/main/docs/deploy/docker.md)。

## 其他安装方式

| 方式 | 文档 |
| --- | --- |
| 宝塔面板“Node 项目” | [baota.md](https://github.com/Glasden/NextSkin/blob/main/docs/deploy/baota.md) |
| 1Panel“Node.js 运行环境” | [1panel.md](https://github.com/Glasden/NextSkin/blob/main/docs/deploy/1panel.md) |
| systemd | [systemd.md](https://github.com/Glasden/NextSkin/blob/main/docs/deploy/systemd.md) |
| Windows（控制台、NSSM） | [windows.md](https://github.com/Glasden/NextSkin/blob/main/docs/deploy/windows.md) |

## 配置

进程环境变量优先于 `.env`；相对路径按发行根目录解析，与工作目录无关。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `NEXTSKIN_SECRET` | 第一次 `start` 生成并写进 `.env` | 至少 32 个字符，加密后台保存的机密设置 |
| `NEXTSKIN_DATA_DIR` | `data` | SQLite 库、材质、插件、`setup-code`、`backups/` 都在这里，运行用户要能写 |
| `NEXTSKIN_DATABASE_URL` | `sqlite:<数据目录>/nextskin.sqlite` | 或 `mysql://用户:密码@主机:端口/库名`、`postgres://…`，库要先建好 |
| `NEXTSKIN_HOST` | `0.0.0.0` | 只经同机反向代理访问时改成 `127.0.0.1` |
| `NEXTSKIN_PORT`、`PORT` | `3000` | 先读 `NEXTSKIN_PORT` |

## 升级与回退

- 迁移是单向的：升级到带迁移的版本之后，旧版本打不开这个库。先读发布说明。
- 站点每天读一次签过名的版本清单（`dl.nextskin.org`，不带站点的任何信息），有新版本时后台提示。后台“设置 → 高级”里能关掉。

### 发行包：后台一键升级

后台的“更新”页（超级管理员）：先**准备**——下载、核对签名、解压、对着在用的库预检，站点照常运行；看过预检结果再**升级**，站点停几秒到三十多秒。程序按版本放在 `releases/` 下，升级只是换一个指针，上一个版本留着，可以回滚。

| 情况 | 升级前 | 新版本没起来时 |
| --- | --- | --- |
| 没有迁移 | — | 自动换回旧版本 |
| SQLite 有迁移 | 自动备份到 `data/backups/` | 自动换回备份和旧版本 |
| MySQL、PostgreSQL 有迁移 | 自己备份，在后台确认 | 不自动回滚数据库，按后台的说明用备份恢复 |

- 回滚只能回到上一个版本。SQLite 有迁移时用升级前的备份换回库，**之后的写入都会丢失**；MySQL、PostgreSQL 有迁移时先自己恢复库，再确认。
- 命令行也能做：`node nextskin.mjs update`、`rollback`，见[命令行](/guide/commands/#update)。
- 运行管理进程的用户要能写 `releases/`，否则只检测。

### 发行包：手动升级

停服务 → 备份 `data/` 和 `.env` → 把新的 ZIP 覆盖解压到原目录 → 启动。启动时管理进程发现新版本，照一键升级的流程预检、迁移、启动，失败时回到旧版本。MySQL、PostgreSQL 有迁移时不会自己升级：照旧运行旧版本，备份以后到后台确认，或者停着服务运行 `node nextskin.mjs update --backup-confirmed`。

0.4 及更早的版本是旧的目录布局，也是覆盖解压就行，这一次没有可回滚的上一个版本。失败时启动以 78 退出、旧程序留着；MySQL、PostgreSQL 有迁移时也以 78 退出，备份以后停着服务运行 `node nextskin.mjs update --backup-confirmed`，再启动。

### Docker

镜像里只检测、不一键升级：备份数据卷，把 `compose.yaml` 里的标签换成新版本，`docker compose pull && docker compose up -d`。SQLite 的迁移前备份照样在 `/data/backups/`。

完整步骤和手工回退见 [docs/deploy 的升级和回退](https://github.com/Glasden/NextSkin/blob/main/docs/deploy/README.md#升级和回退)。

## 接下来

- [命令行](/guide/commands/)：启动、检查、提权、找回超级管理员
- [本地开发](/development/)：从仓库跑起来，改代码
- 安装插件：装好站后在后台的插件页上传 `.tgz`，或者用 `nextskin plugin install`
