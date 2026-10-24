---
title: Docker
description: 用官方镜像和 Compose 部署 NextSkin：密钥、数据卷、端口、受信任的反向代理、从 Blessing Skin 导入和升级。
---

镜像 `ghcr.io/glasden/nextskin`，支持 linux/amd64 和 linux/arm64。镜像里不做一键升级，升级就是换标签（见文末）。

## Compose

用仓库里的 [compose.yaml](https://github.com/Glasden/NextSkin/blob/main/docs/deploy/compose.yaml)：

```bash
mkdir nextskin && cd nextskin
echo "NEXTSKIN_SECRET=$(openssl rand -hex 32)" > .env && chmod 600 .env
curl -fsSLO https://raw.githubusercontent.com/Glasden/NextSkin/main/docs/deploy/compose.yaml
docker compose up -d
docker compose exec nextskin cat /data/setup-code
```

然后配好[反向代理](/guide/install/reverse-proxy/)，经反向代理打开 `https://<域名>/setup` [建站](/guide/install/#建站)。

- **`.env` 要另外备份**：`NEXTSKIN_SECRET` 加密后台保存的机密设置，它不在数据卷里。容器里没有 `.env`，密钥只能由环境变量给出，缺了就以退出码 78 退出。
- 端口只绑在 `127.0.0.1:3000`，前面放反向代理。要直接对外就去掉 `127.0.0.1:`，注意 Docker 发布的端口不受 ufw、firewalld 管。
- `stop_grace_period: 40s`：Docker 默认 10 秒就强杀，NextSkin 来不及收尾。用 `docker run` 时加 `--stop-timeout 40`。
- 用目录挂载代替命名卷时，先 `sudo chown 1000:1000 <目录>`，否则日志说数据目录不可写，退出码 78。
- 用 MySQL、PostgreSQL：设 `NEXTSKIN_DATABASE_URL`。数据库在宿主机上时，容器里的 `127.0.0.1` 是容器自己，要写宿主机在 Docker 网络里的地址。

## 镜像

- 标签：每个版本 `X.Y.Z`；正式版发布后，`X.Y`、`X`、`latest` 指向各自范围里最新的版本。生产环境建议写死 `X.Y.Z`，升级前读发布说明。
- `/app` 是程序，属于 root，进程写不了；`/data` 是数据卷（`NEXTSKIN_DATA_DIR=/data`），属于 uid 1000（`node`），进程以 uid 1000 运行。
- 可以加 `read_only: true`（`docker run --read-only`），只有 `/data` 要写。
- 1 号进程是 tini，停止信号交给启动器。`HEALTHCHECK` 请求本机的 `/api/health`。
- 设了 `NEXTSKIN_MANAGER=off`：没有管理进程，进程模型是启动器 → 核心。
- 日志：`docker logs` 和数据卷里的 `logs/` 各一份。compose.yaml 给 json-file 驱动设了上限，Docker 默认不轮换。

## 受信任的反向代理

宿主机上的反向代理经发布的端口连进来，容器看到的对端是这个 Docker 网络的网关，不是访客。查网关地址：

```bash
docker network inspect <项目名>_default -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
```

`<项目名>` 默认是 compose.yaml 所在目录的名字。建站后把这个地址加进后台“设置 → 高级 → 受信任的反向代理”，再按[反向代理与 HTTPS](/guide/install/reverse-proxy/#受信任的反向代理) 的方法核对。不加的话，所有访客的 IP 都是网关，按 IP 的注册限制和限流对所有人一起生效。

外部客户端直连发布的端口时，NextSkin 看到的是真实地址。

## 命令行

服务运行时：

```bash
docker compose exec nextskin nextskin doctor
docker compose exec nextskin nextskin set-role owner@example.com superadmin
```

镜像里的 `nextskin` 等于 `node /app/nextskin.mjs`，全部命令见[命令行](/guide/commands/)。

## 从 Blessing Skin 导入

导入要停服务，并且容器要能读到旧站的 `.env`、材质目录，连得上旧库。旧站 `.env` 里 `DB_HOST=127.0.0.1` 时，在容器里连的是容器自己，所以命令行导入用宿主机网络（只适用于 Linux）：

```bash
docker compose stop nextskin
docker run --rm --network host --env-file .env \
  -v <项目名>_data:/data -v /srv/blessing-skin:/bs:ro \
  ghcr.io/glasden/nextskin:<版本> import blessing-skin --bs-env /bs/.env --dry-run
```

- `--env-file .env` 给出同一个 `NEXTSKIN_SECRET`；数据卷名用 `docker volume ls` 查，Compose 里是 `<项目名>_data`。
- 旧站 `.env` 里的 `TEXTURES_DIR` 是相对路径时按 `.env` 所在目录解析（挂进来后是 `/bs/storage/textures`）；是绝对路径时挂到同一个路径，或者用 `--textures` 指定。
- NextSkin 自己用的数据库按 Compose 里的服务名访问时，宿主机网络里解析不了这个名字，改用发布出来的地址。
- 去掉 `--dry-run` 和其余步骤见[迁移指南](https://github.com/Glasden/NextSkin/blob/main/packages/importer/MIGRATION.md)。导入完 `docker compose start nextskin`。
- 也可以在 `/setup` 里网页导入：给 `nextskin` 服务挂上旧站目录（只读），粘贴的旧站 `.env` 里把 `DB_HOST` 改成容器能连到的地址。

这一节没有实测过。

## 升级与回退

镜像的根文件系统只读、版本就是标签，所以不做一键升级。后台“更新”页照样提示新版本和发布说明，升级照下面的步骤换标签：

```bash
docker compose stop
# 备份数据卷；.env 另外备份
docker run --rm -v <项目名>_data:/data:ro -v "$PWD":/backup debian:trixie-slim \
  tar czf /backup/nextskin-data.tgz -C /data .
# 把 compose.yaml 里的标签改成新版本
docker compose up -d
```

迁移是单向的：升级到带迁移的版本以后，旧版本打不开这个库。SQLite 有迁移时，迁移前的自动备份在数据卷的 `/data/backups/`。回退：把标签改回旧版本，然后

```bash
docker compose run --rm --no-deps --entrypoint sh nextskin -c \
  'cp /data/backups/<备份文件> /data/nextskin.sqlite && rm -f /data/nextskin.sqlite-wal /data/nextskin.sqlite-shm'
docker compose up -d
```

换回备份以后，升级之后的写入都会丢失。MySQL、PostgreSQL 不自动备份，用你自己升级前做的备份恢复。
