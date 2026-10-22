# 部署

写给服主和替服主操作的 agent：只写事实、命令和已知的坑，面向玩家和服主的文档站另建。标"未实测"的条目是按代码、面板源码推断的，没有在真实环境里跑过。

| 方式                  | 页面                                     | 实测情况（2026-10）                                        |
| --------------------- | ---------------------------------------- | ---------------------------------------------------------- |
| 宝塔面板的"Node 项目" | [baota.md](baota.md)                     | 宝塔 13.0：启动、停止、重启；nginx 配置只读了模板和面板源码 |
| 1Panel 的 Node.js 运行环境 | [1panel.md](1panel.md)              | 1Panel v2.4.0：启动、停止；反向代理未实测                   |
| Docker、Compose       | [docker.md](docker.md)、[compose.yaml](compose.yaml) | arm64：只读运行、停止、健康检查；amd64 待 CI 首次运行   |
| systemd               | [systemd.md](systemd.md)                 | 临时单元：停止、强杀后重启、退出码 78 不重启；单元文件：启动、重启；开机自启未实测 |
| Windows               | [windows.md](windows.md)                 | 从发行目录启动；Ctrl+C 停止和做成服务未实测                 |

## 发行包

- GitHub Releases 上的 `nextskin-<版本>.zip`，用同一页的 `SHA256SUMS` 核对：`sha256sum -c SHA256SUMS`。镜像见 [docker.md](docker.md)。
- 需要 Node 24 或更新，推荐 26：24、25 上 plugin host 拦不住插件绕过站点直接连网，`start` 和 `doctor` 会提示。包里不带 Node，也不需要 `npm install`。
- 解压后：

  ```
  nextskin/
  ├─ nextskin.mjs    启动器和命令行的入口
  ├─ cli/ server/    程序，升级时整个替换
  ├─ package.json    只有 scripts.start = "node nextskin.mjs start"，给面板用
  ├─ README.md  .env.example
  ├─ .env            第一次 start 时生成（权限 600），存 NEXTSKIN_SECRET
  └─ data/           数据目录：SQLite 库、材质、插件、setup-code、backups/
  ```

## 配置

进程环境变量优先于 `.env`。相对路径按发行根目录解析，与工作目录无关。

| 变量                    | 默认                               | 说明                                                                                                                  |
| ----------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `NEXTSKIN_SECRET`       | 第一次 `start` 生成并写进 `.env`   | 至少 32 个字符，加密后台保存的机密设置（OAuth secret、SMTP 密码等）。丢了这些设置要重填。写不了 `.env` 时必须用环境变量给出 |
| `NEXTSKIN_DATA_DIR`     | `data`                             | 运行服务的用户要能写                                                                                                  |
| `NEXTSKIN_DATABASE_URL` | `sqlite:<数据目录>/nextskin.sqlite` | 或 `mysql://用户:密码@主机:端口/库名`、`postgres://…`（`postgresql://` 也行）。库要先建好；用户名、密码里的特殊字符要 URL 编码。测试覆盖 MySQL 8.4、MariaDB 10.11、PostgreSQL 15 |
| `NEXTSKIN_HOST`         | `0.0.0.0`                          | 只经同机反向代理访问时改成 `127.0.0.1`。不读 `HOSTNAME`                                                                |
| `NEXTSKIN_PORT`、`PORT` | `3000`                             | 先读 `NEXTSKIN_PORT`                                                                                                  |
| `NEXTSKIN_ENV_FILE`     | `.env`                             | 只能在进程环境里设                                                                                                    |

## 建站

1. 第一次启动后打开 `/setup`，输入数据目录里 `setup-code` 文件的内容（只有运行服务的用户能读，日志里只有它的位置）。建好站后这个文件被删除，`/setup` 返回 404。
2. "站点地址"填玩家实际访问的地址，例如 `https://skin.example.com`。登录、注册要求请求的 `Origin` 和它一致，邮件链接、通行密钥也用它；填成内网地址就登录不了。以后在后台"设置 → 站点 → 站点地址"改；改了域名，已有的通行密钥都不能再用。
3. 从 Blessing Skin 迁移：`/setup` 里选"从 Blessing Skin 导入"，或用命令行，见 [`packages/importer/MIGRATION.md`](../../packages/importer/MIGRATION.md)。

## 反向代理

用实测过的 nginx 配置：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 12m;
}
```

- `Host` 和 `X-Forwarded-Proto` 决定协议端点算出来的站点地址（外置登录的 `X-Authlib-Injector-API-Location` 头、材质地址）。`Host` 要和玩家请求里的一致：`$host:$server_port` 在 HTTPS 站点上会变成 `域名:443`，不带 `X-Forwarded-Proto` 会算成 `http://`。`X-Forwarded-Proto` 不看受信任的代理。
- `client_max_body_size`：nginx 默认 1m，插件包最大 10 MB，材质默认 1 MB（后台可调）。太小时上传返回 413。
- 不需要 WebSocket、SSE。

### 受信任的反向代理

只有来自后台"设置 → 高级 → 受信任的反向代理"里的地址的请求，才采信 `X-Forwarded-For`。默认是 `127.0.0.0/8`、`::1`，同机的 nginx 不用改。

反向代理和 NextSkin 不在同一个网络命名空间里时（Docker、1Panel、另一台机器），NextSkin 看到的对端地址是网关或代理的地址，要把它加进去；否则所有访客共用一个 IP，按 IP 的注册限制和限流对所有人一起生效。

确认方法：经反向代理登录后台，看"审计日志"里自己这次登录的 IP。是你的公网 IP 就对了；是 `172.x`、`10.x` 这类地址，就把这个地址加进受信任的反向代理，退出再登录一次核对。

### CDN 和内容安全策略

页面带 `Content-Security-Policy` 响应头：只执行带本次请求 nonce 的脚本（ADR-0053）。反向代理和 CDN 不要去掉或改写这个头，也不要另加一条 CSP。往页面里插脚本、改写页面里的脚本的 CDN 功能会被它拦下，以 Cloudflare 为例：

- **Rocket Loader**、**邮箱地址混淆**（Scrape Shield 里的 Email Address Obfuscation）：关掉。它们改写页面里的脚本，不带 nonce，浏览器不执行；改写过的 HTML 还可能和页面的脚本对不上，按钮、表单失灵。
- **Bot Fight Mode**（JavaScript Detections）：可以开。Cloudflare 会读响应头里的 CSP，给它插的脚本带上同一个 nonce。
- **Web Analytics** 的自动注入：未实测。

## 进程管理

- `start` 是启动器：拉起核心，核心崩溃时自己重启（退避），不需要 pm2。
- 停止：给启动器发 SIGTERM 或 SIGINT（Windows 上是 Ctrl+C）。核心先收尾正在处理的请求和后台任务，最多 30 秒后被强杀；监管方的停止超时设成 40 秒。整棵进程树一起收到 SIGTERM 也没问题。
- 退出码：`0` 正常停止；`78` 配置错误（密钥太短、数据目录不可写、端口无效、数据目录已有服务在用……），重启也没用，监管方不要重启；`1` 其他错误。
- 同一个数据目录同时只能运行一个 `start`。上一个还在退出时，新的最多等 40 秒，所以"停止后立即启动"的重启也能用。
- 日志写到 stdout、stderr，不含密码、令牌、Cookie、连接串。

## 命令行

在发行目录里运行 `node nextskin.mjs <命令>`，`help` 列出全部命令。要用运行服务的那个用户执行（宝塔 `sudo -u www`、systemd 的 `User=`、Docker 用 `docker compose exec`），否则数据目录里会出现别的用户的文件，服务读写不了。

| 命令                                                    | 用途                                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `doctor`                                                | 只读检查 Node、密钥、数据目录、数据库和迁移、plugin host、服务在不在运行；有失败时退出码 1 |
| `set-role <邮箱> <身份>`                                 | 身份：`banned`、`user`、`admin`、`superadmin`                                              |
| `set-password <邮箱或 uid>`、`disable-2fa <邮箱或 uid>` | 找回超级管理员（后台改不了超级管理员）                                                     |
| `disable-captcha`                                       | 验证码配错、自己也登不进去时关掉它                                                         |
| `maintenance [on\|off]` | 查看或开关手动维护模式：除了管理员，别人只能看到维护页（ADR-0044）。备份、整理数据之前先挂上 |
| `plugin list`、`plugin install <插件包> [--yes]`、`plugin enable\|disable <id>`、`plugin uninstall <id> [--yes]` | 不用后台管理插件（ADR-0049）：安装或升级先列出插件会做什么，第一次安装、升级多了能力和卸载要确认，脚本里加 `--yes`。启用、升级上传的插件时会临时拉起 plugin host 跑迁移。运行中的服务最多 5 秒后跟上 |
| `migrate`                                               | 只执行迁移；平时 `start` 会自动执行                                                        |
| `import blessing-skin …`                                | 从 BS v6 导入，服务要停着，见 MIGRATION.md                                                  |

除了 `import`，这些命令都可以在服务运行时执行。

## 升级和回退

- 迁移是单向的：升级到带迁移的版本之后，旧版本打不开这个库。先读发布说明。
- 升级：停服务 → 备份 `data/` 和 `.env` → 删掉 `server/`、`cli/` → 解压新包覆盖 → 启动。启动时自动执行迁移。
- 手工备份 SQLite：先停服务，再拷整个 `data/`。停止后 `nextskin.sqlite-wal` 可能还在，最近的写入在里面，只拷 `nextskin.sqlite` 会丢。
- SQLite：有要执行的迁移时，迁移之前自动备份到 `data/backups/nextskin-<UTC 时间>-<第一个迁移>.sqlite`，留最近 3 份。备份失败就不迁移、核心不启动，日志说明原因（多半是空间或权限）。MySQL、PostgreSQL 不自动备份，升级前自己备份。
- 回退（SQLite）：停服务 → 换回旧版本的 `server/`、`cli/`、`nextskin.mjs` → 把备份复制成 `data/nextskin.sqlite` → 删掉 `data/nextskin.sqlite-wal`、`data/nextskin.sqlite-shm`（留着会把新库的页面重放到旧文件上）→ 启动。

## 检查

```bash
node nextskin.mjs doctor
curl -s https://skin.example.com/api/health            # {"status":"ok"}
curl -s -o /dev/null -D - https://skin.example.com/api/health | grep -i x-authlib-injector-api-location
# 应该是 https://skin.example.com/api/yggdrasil；协议或端口不对就是反向代理的 Host、X-Forwarded-Proto 没配好
```

后台"设置 → Yggdrasil"里关掉"返回 API 地址指示"时没有这个头，先打开再核对。

## 防火墙

- 面板装好后可能改过防火墙：1Panel 安装时放行面板端口，运行后还加了对所有来源放行 80、443 的规则（注释 `1panel-rule`），卸载时不删。已有自定义规则的服务器，装面板前后对比 `ufw status numbered`。
- Docker 发布的端口绕过 ufw、firewalld。只给反向代理用的端口绑 `127.0.0.1`。
