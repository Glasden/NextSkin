# 部署

写给服主和替服主操作的 agent：只写事实、命令和已知的坑，面向玩家和服主的文档站另建。标"未实测"的条目是按代码、面板源码推断的，没有在真实环境里跑过。

| 方式                  | 页面                                     | 实测情况（2026-10）                                        |
| --------------------- | ---------------------------------------- | ---------------------------------------------------------- |
| 宝塔面板的"Node 项目" | [baota.md](baota.md)                     | 宝塔 13.0：启动、停止、重启；nginx 配置只读了模板和面板源码 |
| 1Panel 的 Node.js 运行环境 | [1panel.md](1panel.md)              | 1Panel v2.4.0：启动、停止；反向代理未实测                   |
| Docker、Compose       | [docker.md](docker.md)、[compose.yaml](compose.yaml) | arm64：只读运行、停止、健康检查；amd64 待 CI 首次运行   |
| systemd               | [systemd.md](systemd.md)                 | 临时单元：停止、强杀后重启、退出码 78 不重启；单元文件：启动、重启；开机自启未实测 |
| Windows               | [windows.md](windows.md)                 | 从发行目录启动；Ctrl+C 停止和做成服务未实测                 |

上表的实测用的是 0.4 的布局（根目录直接是启动器）。之后的版本多了一层管理进程（ADR-0061）：从上一个正式版覆盖解压升级由发布工作流冒烟（SQLite、PostgreSQL），systemd 的权限分离在容器里以 root 实测过；各面板上的一键升级和回滚未实测，见各页的"升级"一节。

## 发行包

- GitHub Releases 上的 `nextskin-<版本>.zip`，用同一页的 `SHA256SUMS` 核对：`sha256sum -c SHA256SUMS`。正式版另附 `SHA256SUMS.sig`，用发布公钥（`apps/docs/public/release-keys/`，文档站上是 `https://docs.nextskin.org/release-keys/<key id>.pem`）核对：`openssl pkeyutl -verify -pubin -inkey 2026-10.pem -rawin -in SHA256SUMS -sigfile SHA256SUMS.sig`（ADR-0061）。镜像见 [docker.md](docker.md)。
- 需要 Node 24 或更新，推荐 26：24、25 上 plugin host 拦不住插件绕过站点直接连网，`start` 和 `doctor` 会提示。包里不带 Node，也不需要 `npm install`。
- 解压后（ADR-0061）：

  ```
  nextskin/                 实例目录
  ├─ nextskin.mjs           入口：管理进程和命令行，面板、systemd 都运行它
  ├─ manager/               管理进程：选版本启动、监管、升级、回滚
  ├─ releases/
  │  ├─ <版本>/             一个版本的程序（nextskin.mjs、cli/、server/），运行时不改
  │  ├─ current.json        指针：当前版本、上一个版本，第一次 start 时生成
  │  └─ update-log.jsonl    每次升级、回滚的结果
  ├─ package.json           只有 scripts.start = "node nextskin.mjs start"，给面板用
  ├─ README.md  .env.example
  ├─ .env                   第一次 start 时生成（权限 600），存 NEXTSKIN_SECRET
  └─ data/                  数据目录：SQLite 库、材质、插件、setup-code、backups/
  ```

  `releases/` 里平时有两个版本：在用的和上一个（留作回滚），升级时还有下载中的 `.staging/`。运行中还有 `manager.lock`、`manager.sock`、`manager.token`（POSIX 上 600）。

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
| `NEXTSKIN_LOG_LEVEL` | `info` | `debug`、`info`、`warn`、`error`。排查问题时临时改成 `debug`，插件的 `debug` 日志也会出来 |
| `NEXTSKIN_LOG_FORMAT` | `text` | `json` 时每行写一条 JSON（NDJSON），给 journald、Docker 后面再接日志系统的人用 |

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

### 缓存

能长期缓存的响应，NextSkin 自己带上了 `Cache-Control`：`/_next/static/` 下的脚本、样式和出图（`/render/…`，地址里带出图的版本）是一年的 `immutable`；材质文件按后台"设置 → 高级 → 公开资源的缓存时间"（默认一年）。浏览器和 CDN 照着缓存就够了，反向代理不用另外配。

不要用 `alias`、`root` 让 nginx 直接读程序目录或数据目录里的文件：

- `/_next/static/`：程序在 `releases/<版本>/` 里，路径每次升级都变。指向旧路径的配置在升级以后让全站的脚本和样式 404。
- `/textures/…`：NextSkin 只返回还在用的材质（删掉的材质，文件默认一小时以后才从磁盘上清掉），`ETag`、`Last-Modified` 也是协议约定的格式。直接读文件会把删掉的材质继续发出去，响应头和皮肤站模组、启动器期待的对不上，还得让 nginx 的用户能进数据目录。

想让 nginx 少回源，就用 `proxy_cache` 反代这两类路径、只缓存 200（在线上站点实测过）：

```nginx
# http 块里（proxy_cache_path 只能放在 http 上下文）
proxy_cache_path /var/cache/nginx/nextskin levels=1:2 keys_zone=nextskin:16m max_size=512m inactive=30d use_temp_path=off;
```

```nginx
# server 块里，和 location / 并列；/render/ 再写一段同样的
location /_next/static/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_cache nextskin;
    proxy_cache_valid 200 30d;
}
```

升级的那一刻，还开着旧页面的访客会请求旧版本的文件、得到 404；只缓存 200，这些 404 不会留在缓存里。

### CDN 和内容安全策略

页面带 `Content-Security-Policy` 响应头：只执行带本次请求 nonce 的脚本（ADR-0053）。反向代理和 CDN 不要去掉或改写这个头，也不要另加一条 CSP。往页面里插脚本、改写页面里的脚本的 CDN 功能会被它拦下，以 Cloudflare 为例：

- **Rocket Loader**、**邮箱地址混淆**（Scrape Shield 里的 Email Address Obfuscation）：关掉。它们改写页面里的脚本，不带 nonce，浏览器不执行；改写过的 HTML 还可能和页面的脚本对不上，按钮、表单失灵。
- **Bot Fight Mode**（JavaScript Detections）：可以开。Cloudflare 会读响应头里的 CSP，给它插的脚本带上同一个 nonce。
- **Web Analytics** 的自动注入：未实测。

## 进程管理

- `start` 是管理进程：按 `releases/current.json` 启动那个版本的启动器并监管它；启动器再拉起核心，核心崩溃时自己重启（退避）。不需要 pm2。
- 停止：给 `start` 发 SIGTERM 或 SIGINT（Windows 上是 Ctrl+C）。它经 IPC 让启动器按顺序停下：核心先收尾正在处理的请求和后台任务，最多 30 秒后被强杀；启动器 35 秒还没退出就被强杀。监管方的停止超时设成 40 秒。整棵进程树一起收到 SIGTERM 也没问题；管理进程被强杀时，启动器发现 IPC 断了也会自己停下。
- 退出码：`0` 正常停止；`78` 配置错误（密钥太短、数据目录不可写、端口无效、数据目录已有服务在用、`current.json` 损坏……），重启也没用，监管方不要重启；`1` 其他错误。
- 同一个实例目录同时只能运行一个 `start`。上一个还在退出时，新的最多等 40 秒，所以"停止后立即启动"的重启也能用。
- 日志写到 stdout、stderr：核心的日志每行带时间、级别和来源（`2026-10-24 20:15:03.123 WARN  core/mail …`），`warn` 及以上写 stderr，其余写 stdout。不含密码、令牌、Cookie、连接串。
- 不想要管理进程（只检测、不一键升级）：设环境变量 `NEXTSKIN_MANAGER=off`，入口在本进程里直接运行当前版本的启动器，进程模型和以前一样。镜像里设了它。

## 命令行

在发行目录里运行 `node nextskin.mjs <命令>`，`help` 列出全部命令。要用运行服务的那个用户执行（宝塔 `sudo -u www`、systemd 的 `User=`、Docker 用 `docker compose exec`），否则数据目录里会出现别的用户的文件，服务读写不了。

| 命令                                                    | 用途                                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `doctor`                                                | 只读检查 Node、密钥、数据目录、数据库和迁移（含已启用的官方插件）、plugin host、服务在不在运行；有失败时退出码 1。`--json` 输出机器可读的结果 |
| `set-role <邮箱> <身份>`                                 | 身份：`banned`、`user`、`admin`、`superadmin`                                              |
| `set-password <邮箱或 uid>`、`disable-2fa <邮箱或 uid>` | 找回超级管理员（后台改不了超级管理员）                                                     |
| `disable-captcha`                                       | 验证码配错、自己也登不进去时关掉它                                                         |
| `maintenance [on\|off]` | 查看或开关手动维护模式：除了管理员，别人只能看到维护页（ADR-0044）。备份、整理数据之前先挂上 |
| `plugin list`、`plugin install <插件包> [--yes]`、`plugin enable\|disable <id>`、`plugin uninstall <id> [--yes]` | 不用后台管理插件（ADR-0049）：安装或升级先列出插件会做什么，第一次安装、升级多了能力和卸载要确认，脚本里加 `--yes`。启用、升级上传的插件时会临时拉起 plugin host 跑迁移。运行中的服务最多 5 秒后跟上 |
| `migrate`                                               | 只执行迁移（核心和已启用的官方插件）；平时 `start` 会自动执行。`--json` 输出执行了哪些、备份在哪里 |
| `import blessing-skin …`                                | 从 BS v6 导入，服务要停着，见 MIGRATION.md                                                  |

除了 `import`，这些命令都可以在服务运行时执行。

## 升级和回退

- 迁移是单向的：升级到带迁移的版本之后，旧版本打不开这个库。先读发布说明；要不要停、迁移有几个、失败时会怎样，以后台的预检结果为准。
- 站点每天读一次 `https://dl.nextskin.org/releases/v1.json`（签过名的版本清单，不带站点的任何信息），有新版本时后台概览和"更新"页提示，超级管理员收到一条通知。后台"设置 → 高级"里能关掉。

### 一键升级（发行包）

后台"更新"页（只有超级管理员能进）：

1. **准备**：下载 ZIP（先试 `dl.nextskin.org`，再试 GitHub）、核对签名和 SHA-256、解压到 `releases/<版本>/`，再用新版本的 `doctor` 对着在用的库预检。站点照常运行。
2. 看预检的结果：数据库、迁移有几个、和新版本不兼容的插件、失败时会怎样。
3. **升级**：管理进程停掉旧版本（站点停几秒到三十多秒，期间反向代理返回 502）→ 用新版本执行迁移 → 改指针 → 启动新版本，等它的 `/api/health` 返回 200（最多 2 分钟）→ 删掉在用和上一个以外的版本目录。

新版本没有通过健康检查时：

| 情况 | 升级前 | 新版本没起来时 |
| ---- | ------ | -------------- |
| 没有迁移 | — | 自动换回旧版本 |
| SQLite 有迁移 | 迁移前自动备份到 `data/backups/` | 换回备份（连同删掉 `-wal`、`-shm`）和旧版本 |
| PostgreSQL 有迁移 | 自己备份，在后台勾选"已经备份" | 迁移失败、库没变（核心的迁移整批一个事务）：换回旧版本。迁移成功但新版本没起来，或者核心的迁移提交了、官方插件的迁移失败：不自动回滚，新版本留着，按后台的说明用备份恢复 |
| MySQL、MariaDB 有迁移 | 同上 | 迁移失败：库可能停在中间（DDL 不能回滚），换回旧版本；旧版本打不开时就停在那里，用备份恢复。有迁移已经提交时：同上一行 |

- 要求：运行管理进程的用户能写 `releases/`。写不了时只检测，更新页说明原因。各部署方式见各自的页面。
- 新版本要的 Node 比服务器上的新：预检拦下，先换 Node。
- 新版本要的管理进程比在用的新（很少见）：一键升级的目标是在用的管理进程升得了的版本里最新的一个，升过去以后重启一次服务，让它带来的新管理进程生效，再升到最新。更新页会写明这几步；没有这样的中间版本时，只能照"手动升级"覆盖解压。
- 准备时失败（下载失败、空间不足、Node 太旧、预检没过）不影响这个版本，修好以后再准备就行。迁移以后失败的版本会记下，更新页注明上次在这里失败过，命令行的 `update` 不再默认选它（`--to` 照样能选）。
- 结果记在 `releases/update-log.jsonl`，后台显示最近一次。

命令行（在实例目录里，用运行管理进程的用户）：

| 命令 | 用途 |
| ---- | ---- |
| `node nextskin.mjs update --check` | 列出比当前新的正式版 |
| `node nextskin.mjs update [--to <版本>] [--yes] [--backup-confirmed]` | 升级，默认到最新的正式版（手动解压了更新的版本时到解压的版本）。服务运行时交给管理进程，和后台一样；服务停着时自己执行同一条流水线，最后不启动服务（也就不做健康检查）。MySQL、PostgreSQL 有迁移时要 `--backup-confirmed`；不是终端时要 `--yes` |
| `node nextskin.mjs rollback [--yes]` | 回到上一个版本，规则见下。MySQL、PostgreSQL 有迁移时只能在服务停着时运行 |
| `node nextskin.mjs update status` | 当前版本、上一个版本、进行中的操作、最近一次的结果 |
| `node nextskin.mjs releases` | 列出 `releases/` 里的版本和指针 |

### 回滚

只能回到上一个版本（`current.json` 里的 `previous`）：后台"更新"页，或 `node nextskin.mjs rollback`。

- 那次升级没有迁移：直接换回去。
- SQLite 有迁移：用那次升级前的备份换回库，**升级以后的所有写入都会丢失**，要确认。之后上传的材质文件留在存储里，由孤儿文件的回收清掉。
- MySQL、PostgreSQL 有迁移：程序不碰库，也不能在后台回滚（恢复库的时候新版本还在线、还在写库）。照这个顺序做：
  1. 停掉服务；
  2. 用升级前的备份恢复数据库；
  3. 在实例目录里运行 `node nextskin.mjs rollback --yes`：它先用旧版本核对库确实恢复了，再把指针换回旧版本；
  4. 启动服务。

### 手动升级

- 照旧可以手动升级：停服务 → 备份 `data/` 和 `.env` → 把新的 ZIP 覆盖解压到实例目录 → 启动。不用删任何东西。
- 启动时管理进程发现解压进来的版本比在用的新，就按一键升级的流水线从预检开始（不下载），失败时同样回到旧版本。
- MySQL、PostgreSQL 有迁移时不会自己升级：照旧运行旧版本，日志说明原因。备份以后到后台"更新"页确认升级，或停掉服务后运行 `node nextskin.mjs update --backup-confirmed`。

### 从 0.4 及更早的版本升级

0.4 及更早的发行包是旧的布局（根目录里直接是 `server/`、`cli/`）：

- 照"手动升级"覆盖解压新包，再启动。管理进程第一次启动时用新版本预检、迁移、启动，新版本通过健康检查后删掉根目录的 `server/`、`cli/`。
- 失败时以 78 退出（面板和 systemd 不会反复重启），日志说明原因；`server/`、`cli/` 还在，排除原因后再启动会重试，要回到旧版本照下一条。
- MySQL、PostgreSQL 有迁移时同样不替你确认备份：启动以 78 退出。备份以后在服务停着时运行 `node nextskin.mjs update --backup-confirmed`，再启动。
- 这一次没有可回滚的上一个版本。要回到旧版本：停服务 → 删掉 `nextskin.mjs`、`manager/`、`releases/` → 解压旧版本的 ZIP → SQLite 照下面的手工回退换回备份 → 启动。

### 手工回退（SQLite）

- 手工备份 SQLite：先停服务，再拷整个 `data/`。停止后 `nextskin.sqlite-wal` 可能还在，最近的写入在里面，只拷 `nextskin.sqlite` 会丢。
- SQLite 有要执行的迁移（核心的，或者已启用的官方插件随新版本带来的）时，迁移之前自动备份到 `data/backups/nextskin-<UTC 时间>-<第一个迁移>.sqlite`（只有插件迁移时是 `<插件 id>-<迁移>`），留最近 3 份。备份失败就不迁移，日志说明原因（多半是空间或权限）。MySQL、PostgreSQL 不自动备份。
- SQLite 有迁移时，一键回滚要用到那次升级前的备份（路径记在 `releases/current.json` 的 `upgrades` 里），备份不在就拒绝。挪走了的放回原处再回滚。

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
