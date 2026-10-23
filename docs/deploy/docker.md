# Docker

镜像 `ghcr.io/glasden/nextskin`，linux/amd64 和 linux/arm64。arm64 上实测过只读运行、停止顺序、健康检查和 [compose.yaml](compose.yaml)；amd64 的镜像由 CI 和发布工作流构建、冒烟，还没有运行过。公共部分见 [README.md](README.md)。

## 镜像

- 标签：每个版本 `X.Y.Z`；正式版发布后，`X.Y`、`X`、`latest` 指向各自范围里最新的版本。生产环境建议写死 `X.Y.Z`，升级前读发布说明。
- `/app` 是程序，属于 root，进程写不了；`/data` 是数据卷（`NEXTSKIN_DATA_DIR=/data`），属于 uid 1000（`node`），进程以 uid 1000 运行。
- 没有 `.env`：`NEXTSKIN_SECRET` 必须用环境变量给出，否则退出码 78。它不在数据卷里，要另外备份。
- PID 1 是 tini，停止信号交给启动器。`HEALTHCHECK` 请求本机的 `/api/health`。
- `nextskin` 在 PATH 里，等于 `node /app/nextskin.mjs`。
- 可以加 `read_only: true`（`docker run --read-only`），只有 `/data` 要写。

## Compose

照 [compose.yaml](compose.yaml) 里的注释：

```bash
echo "NEXTSKIN_SECRET=$(openssl rand -hex 32)" > .env && chmod 600 .env
docker compose up -d
docker compose exec nextskin cat /data/setup-code
```

- 端口绑在 `127.0.0.1:3000`，前面放反向代理。
- `stop_grace_period: 40s`：Docker 默认 10 秒就强杀。用 `docker run` 时加 `--stop-timeout 40`。
- 不用命名卷、改用目录挂载时，先 `sudo chown 1000:1000 <目录>`，否则退出码 78、日志说数据目录不可写。
- 用 MySQL、PostgreSQL：设 `NEXTSKIN_DATABASE_URL`；数据库在宿主机上时，容器里的 `127.0.0.1` 是容器自己，要写宿主机在 Docker 网络里的地址。

## 受信任的反向代理

宿主机上的反向代理经发布的端口连进来，容器看到的对端是这个网络的网关，例如 `172.17.0.1`（默认网桥）或 Compose 网络的网关：

```bash
docker network inspect <项目名>_default -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
```

建站后把它加进后台"设置 → 高级 → 受信任的反向代理"，再按 README 的方法看审计日志确认。外部客户端直连发布的端口时，NextSkin 看到的是真实地址。

## 命令行

服务运行时：`docker compose exec nextskin nextskin <命令>`，例如 `doctor`、`set-role`。

## 从 Blessing Skin 导入（未实测）

导入要停服务，并且容器要能读到旧站的 `.env`、材质目录，连得上旧库。旧站的 `.env` 里 `DB_HOST=127.0.0.1` 时，在容器里连的是容器自己，所以命令行导入用宿主机网络（只适用于 Linux）：

```bash
docker compose stop nextskin
docker run --rm --network host --env-file .env \
  -v <项目名>_data:/data -v /srv/blessing-skin:/bs:ro \
  ghcr.io/glasden/nextskin:<版本> import blessing-skin --bs-env /bs/.env --dry-run
```

- `--env-file .env` 给出同一个 `NEXTSKIN_SECRET`；数据卷名用 `docker volume ls` 查，Compose 里是 `<项目名>_data`。
- 旧站 `.env` 里的 `TEXTURES_DIR` 是相对路径时按 `.env` 所在目录解析（挂进来后是 `/bs/storage/textures`）；是绝对路径时挂到同一个路径，或者用 `--textures` 指定。
- NextSkin 自己用的数据库按 Compose 里的服务名访问时，宿主机网络里解析不了这个名字，改用发布出来的地址。
- 去掉 `--dry-run` 和其余步骤见 [MIGRATION.md](../../packages/importer/MIGRATION.md)。导入完 `docker compose start nextskin`。
- 也可以在 `/setup` 里网页导入：给 `nextskin` 服务挂上旧站目录（只读），粘贴的旧站 `.env` 里把 `DB_HOST` 改成容器能连到的地址。

## 升级和回退

镜像里不做一键升级（ADR-0061）：根目录只读、版本就是标签。后台"更新"页照样提示新版本和发布说明，升级照下面的步骤换标签。镜像里设了 `NEXTSKIN_MANAGER=off`，没有管理进程，进程模型和以前一样。

```bash
docker compose stop
docker run --rm -v <项目名>_data:/data:ro -v "$PWD":/backup debian:trixie-slim \
  tar czf /backup/nextskin-data.tgz -C /data .     # 备份数据卷；.env 另外备份
# 把 compose.yaml 里的标签改成新版本
docker compose up -d
```

SQLite 的迁移前自动备份在数据卷的 `/data/backups/`。回退：标签改回旧版本，然后

```bash
docker compose run --rm --no-deps --entrypoint sh nextskin -c \
  'cp /data/backups/<备份文件> /data/nextskin.sqlite && rm -f /data/nextskin.sqlite-wal /data/nextskin.sqlite-shm'
docker compose up -d
```
