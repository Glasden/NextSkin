---
title: 配置与进程
description: NextSkin 的环境变量、数据库连接、进程怎么停止和重启、退出码和日志。
---

站点的大部分设置在后台改，存在数据库里。环境变量只管启动前就要知道的几样：密钥、数据目录、数据库、监听地址和日志。

## 环境变量

发行包读实例目录下的 `.env`，进程的环境变量优先于 `.env`。相对路径按实例目录解析，与工作目录无关。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `NEXTSKIN_SECRET` | 第一次 `start` 生成并写进 `.env` | 至少 32 个字符，加密后台保存的机密设置（SMTP 密码、OAuth secret 等）。丢了这些设置要重填。`.env` 存在却没有这一行时启动失败；写不了 `.env` 时必须用环境变量给出 |
| `NEXTSKIN_DATA_DIR` | `data` | SQLite 库、材质、插件、日志、`setup-code`、`backups/` 都在这里，运行服务的用户要能写 |
| `NEXTSKIN_DATABASE_URL` | `sqlite:<数据目录>/nextskin.sqlite` | 见下面的“数据库” |
| `NEXTSKIN_HOST` | `0.0.0.0` | 只经同机反向代理访问时改成 `127.0.0.1`。不读 `HOSTNAME` |
| `NEXTSKIN_PORT`、`PORT` | `3000` | 先读 `NEXTSKIN_PORT` |
| `NEXTSKIN_ENV_FILE` | `.env` | 换一个配置文件，只能在进程环境里设 |
| `NEXTSKIN_LOG_LEVEL` | `info` | `debug`、`info`、`warn`、`error`。排查问题时临时改成 `debug`，插件的 `debug` 日志也会出来 |
| `NEXTSKIN_LOG_FORMAT` | `text` | `json` 时终端里每行一条 JSON，给后面再接日志系统的人用 |
| `NEXTSKIN_LOG_FILE` | 开 | `off` 时不写数据目录里的 `logs/`，只写终端 |
| `NEXTSKIN_MANAGER` | 开 | `off` 时不启动管理进程，见下文 |
| `NEXTSKIN_RUN_AS` | 不设 | 只在 Linux 等 POSIX 系统上：管理进程以 root 运行，站点降到这个用户，见 [systemd](/guide/install/systemd/) |

改了 `.env` 要重启服务才生效。

## 数据库

默认用数据目录里的 SQLite，不用另装。已经有数据库服务、或者站点写入多（SQLite 同一时间只有一个写入）时，可以换 MySQL、MariaDB 或 PostgreSQL：

```ini
NEXTSKIN_DATABASE_URL=mysql://用户:密码@主机:3306/库名
NEXTSKIN_DATABASE_URL=postgres://用户:密码@主机:5432/库名
```

- 库要先建好，NextSkin 启动时自己建表、跑迁移。
- 用户名、密码里的特殊字符要 URL 编码。
- `postgresql://` 也行。测试覆盖 MySQL 8.4、MariaDB 10.11、PostgreSQL 15。
- SQLite 有迁移时，升级前自动备份；MySQL、PostgreSQL 要自己备份，见[升级与回退](/guide/upgrade/)。
- 数据目录放本地盘。SQLite 放在 NFS、SMB 这类网络盘上又慢又容易锁住。

## 进程

`node nextskin.mjs start` 启动的是管理进程：它按 `releases/current.json` 拉起那个版本的启动器并监管它；启动器再拉起核心（网站本身）和 plugin host（运行插件），核心崩溃时按退避重启。不需要 pm2。

- **停止**：给 `start` 发 SIGTERM 或 SIGINT（Windows 上是 Ctrl+C）。它经 IPC 让启动器按顺序停下：核心先收尾正在处理的请求和后台任务，最多 30 秒后被强杀（日志里记一条“强制结束”）；启动器 35 秒还没退出就被强杀。面板、systemd、Docker 的停止超时要设到 40 秒。整棵进程树一起收到 SIGTERM 也没问题；管理进程被强杀时，启动器发现 IPC 断了也会自己停下。
- **重启**：停止后立即启动就行。同一个实例目录同时只能运行一个 `start`，上一个还在退出时，新的最多等它 40 秒。
- **不要管理进程**：设 `NEXTSKIN_MANAGER=off`，入口在本进程里直接运行当前版本的启动器。这样只检测新版本、不能一键升级。Docker 镜像里设了它。

退出码：

| 退出码 | 含义 | 监管方 |
| --- | --- | --- |
| 0 | 正常停止 | — |
| 1 | 其他错误 | 可以重启 |
| 78 | 配置错误：密钥太短、端口不合法、数据目录写不了或已有服务在用、`releases/current.json` 损坏…… | 不要重启，重启也没用 |

## 日志

- 数据目录的 `logs/nextskin.log`，一行一条 JSON，权限 0600。超过后台“设置 → 高级”里的上限就轮换成 `nextskin.1.log`、`nextskin.2.log`……，默认每份 10 MB、连同当前文件留 5 份。Next 自己打印的内容、崩溃时的堆栈也记在里面。
- 终端（面板的输出、journald、`docker logs`）里是同样的内容，每行带时间、级别和来源，例如 `2026-10-24 20:15:03.123 WARN  core/mail …`。`warn` 及以上写 stderr，其余写 stdout。systemd、Docker 已经存了一份、不想再存的，设 `NEXTSKIN_LOG_FILE=off`。
- 管理进程自己的几行（选版本、升级、回滚）和命令行命令的日志只写终端。
- 日志里不含密码、令牌、Cookie、数据库连接串。
- 超级管理员在后台的“诊断”页能直接看日志、导出诊断包，见[常见问题](/guide/faq/#日志在哪)。
