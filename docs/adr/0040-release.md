# ADR-0040 发布：一个摊平了依赖的通用 ZIP 包加两种架构的镜像，产品版本号独立于 SDK，SQLite 升级前自动备份

- 状态：已采纳（维护分支上发修订版由 ADR-0047 补充；"发布流程"第 1 条"标签指向的提交在 main 上"已被 ADR-0047 取代）
- 日期：2026-10-20
- 补充 ADR-0002：发行物的具体形态和发布流程
- 补充 ADR-0039：组装发行目录时摊平 `node_modules`、写入版本号；升级的步骤和回退

## 背景

ADR-0039 落地了启动器和发行目录 `dist/nextskin/`，把发布流程留给这一份：版本号、CI、校验和，以及镜像的基础镜像、PID 1、停止的宽限时间。ADR-0002 定的发行物是一个通用 ZIP 包，外加 linux/amd64、linux/arm64 两种架构的镜像。

### 现状

- 发行目录 52 MB 的 `server/`（Next standalone）加 6 MB 的 `cli/`。没有 `.node` 原生模块（ADR-0008），程序本身和平台、架构无关。
- `server/node_modules` 是 pnpm 的布局：21 个包放在 `.pnpm/<包名@版本>/node_modules/` 里，互相之间、`apps/web/node_modules/next`、Turbopack 给外部包建的别名 `.next/node_modules/pg-<hash>` 都是符号链接，一共 45 个，全是相对路径的目录链接。
- 这对 ZIP 包是两个问题：
  - Windows 资源管理器解压 ZIP 不认符号链接，账号多半也没有建链接的权限。在 Windows 上组装时只能建 junction，而 junction 只存绝对路径，目录一挪就失效；创建者和使用者的权限不同时，Windows 还拒绝穿过它（实测：计划任务建的 junction，SSH 会话里的 Node 报"不受信任的装入点"）。
  - pnpm 的目录名很长，发行目录里最长的相对路径有 255 个字符。解压到 `C:\Users\…\Downloads\` 这样的位置，超过 Windows 260 个字符的上限。
- 产品还没有版本号：`packages/launcher/package.json` 是 `0.0.0`。插件 SDK 和构建命令用 changesets 管版本，处在 `rc` 预发布模式（ADR-0035）。
- 升级是单向的：每个版本都可能带迁移，旧版本打不开新版本迁移过的库（迁移器报库里有它不认识的迁移，`doctor` 也查这一项）。现在没有任何自动备份。

### 验证：摊平 `node_modules`

拷一份发行目录，把 `.pnpm/*/node_modules/` 里的真实目录挪到 `server/node_modules/<包名>`，删掉 `.pnpm` 和指过去的链接，pg 的 hash 别名换成转发包：

- 21 个包没有同名的两个版本，摊平后没有任何链接，体积不变。最长的相对路径从 255 个字符降到 130。
- SQLite：启动、首页、安装向导、皮肤库、健康检查正常。
- PostgreSQL（测试用的容器，临时建的库）：44 个迁移全部执行，页面正常。
- 转发包第一次只给了 CJS 入口（`module.exports = require('pg')`），PostgreSQL 下报 `Pool is not a constructor`：Turbopack 用 `import()` 加载外部包，而 pg 的具名导出来自它的 ESM 入口。转发包的 `exports` 分出 `import` 入口、从 `pg` 重新导出之后正常。pg 只加载一份：转发包按 Node 的解析找到的就是摊平后的那一份。

Next 产物里还有一些 `/ROOT/node_modules/.pnpm/next@…` 的字符串，是 ncc 编译时留下的资源路径。前缀 `/ROOT/` 是 Turbopack 的占位，本来就不是真实路径，摊平不改变它们的行为。

## 决定

### 版本号

- 产品的版本号用 semver，只写在 `packages/launcher/package.json` 的 `version` 里。`version` 命令、`doctor` 和启动日志都读它；组装时写进发行目录的 `package.json`，另在 `server/` 里写一个版本标记（见"升级"）。
- 和插件 SDK 的版本号无关，不走 changesets：SDK 在 `rc` 预发布模式里，changesets 的预发布模式对一次发版涉及的所有包生效，产品会被带上 `-rc`。维护者手改版本号。
- 1.0 之前用 `0.x`：次版本号可能带不兼容的部署变化（环境变量改名、Node 下限提高），在发布说明里写明；修订号只修问题。1.0.0 起照 semver，只有主版本带不兼容的部署变化。迁移不算不兼容的变化：任何版本都可能带迁移，所以任何升级都是单向的。
- 预发布版本写成 `X.Y.Z-rc.N`。
- git 标签是 `vX.Y.Z`，和 changesets 给 SDK 打的标签（`@nextskin/plugin-sdk@…`）不冲突。

### ZIP 包

文件名 `nextskin-X.Y.Z.zip`，里面的顶层目录是 `nextskin/`，不带版本号：覆盖解压就是升级，面板里配好的项目路径不用改。内容就是发行目录（ADR-0039），另加一个几行的 `README.md`：快速开始和部署文档的链接。

一个包通用于所有平台和架构，前提有两条，组装时检查，不满足就构建失败：

- **没有原生模块**：产物里不能有 `.node` 文件（ADR-0008）。
- **没有符号链接**：组装时把 standalone 的 `node_modules` 摊平。
  - `.pnpm/<id>/node_modules/` 里的真实目录挪到 `server/node_modules/<包名>`（带 scope 的包放进 scope 目录）；同一个包名出现两个版本时构建失败。到时候再按 npm 的方式把冲突的版本嵌套进依赖它的包里，现在没有这种情况，不提前写。
  - 删掉 `.pnpm`，删掉 `apps/web/node_modules` 里指过去的链接：按 Node 的解析往上找，找到的就是摊平后的包。
  - Turbopack 给外部包建的带 hash 的别名换成转发包：`package.json` 的 `exports` 分 `import`、`require` 两个入口，都从真正的包重新导出，包括默认导出。
  - 摊平之后不再有链接，在 Windows 上组装时重建 junction 的代码随之删掉。e2e 照旧从发行目录启动，覆盖摊平后的布局。

不带 Node（ADR-0039）。

### 镜像

`ghcr.io/<所有者>/nextskin`，linux/amd64 和 linux/arm64。

- **基础镜像** `node:26-trixie-slim`，按 digest 固定，由 Renovate 升级。不用 alpine：小几十 MB，但 Node 在 musl 上属于 experimental 支持层级。
- **不在 Docker 里构建**：镜像只是把发布流程打好的发行目录 `COPY` 进去。两种架构的程序完全相同，只有基础镜像和 tini 按架构取；arm64 那份的 `apt-get` 在 QEMU 下运行。
- **布局**：
  - `/app` 是发行目录，属主 root，运行时只读；
  - 以 `node` 用户（uid 1000）运行；
  - `NEXTSKIN_DATA_DIR=/data`，`VOLUME /data`；
  - `NEXTSKIN_HOST=0.0.0.0`，`EXPOSE 3000`。
- **PID 1 是 tini**：`ENTRYPOINT ["tini", "--", "node", "/app/nextskin.mjs"]`，`CMD ["start"]`。
  - 启动器是 Node 进程，做 PID 1 时不回收别人的孤儿进程：核心被强杀后 plugin host 会被过继给 PID 1，退出后成为僵尸。
  - tini 只把信号转给启动器，停止照 ADR-0039 的顺序。
- **密钥只从环境变量给**：`/app` 不可写，没给 `NEXTSKIN_SECRET` 就以 78 退出（ADR-0039 已有的行为）。compose 示例从同目录的 `.env` 取 `NEXTSKIN_SECRET`，并写明怎么生成一个。
- **停止**：`docker stop` 默认只等 10 秒，而启动器最多等 30 秒，compose 示例写 `stop_grace_period: 40s`。10 秒就被强杀也不会弄坏数据：执行到一半的任务按租约由下次启动接手（ADR-0021）。
- **健康检查**：`HEALTHCHECK` 用 Node 的 `fetch` 请求本机的 `/api/health`，镜像里没有 curl。
- **命令行**：镜像里放一个 `/usr/local/bin/nextskin` 脚本，转给 `node /app/nextskin.mjs`。
  - 服务运行时用 `docker compose exec nextskin nextskin set-role …`；
  - 导入要先停服务，用 `docker compose run --rm nextskin import blessing-skin …`，旧站的 `.env` 和材质目录挂进去。
- **标签**：每个版本推 `X.Y.Z`；正式版（不是预发布）发布以后再加 `X.Y`、`X`、`latest`。
- **落地时验证**：`/app` 只读时核心能不能运行（Next 运行时会不会往 `.next/cache` 写东西）。不能的话，把那个目录指到 `/data` 下或者用 tmpfs，写进这份 ADR 的落地补充。
- （落地时补充，2026-10-20，在 arm64 的服务器上实测，amd64 由 CI 的冒烟测试覆盖：
  - **只读**：根文件系统整个只读（`--read-only`）、只挂 `/data` 时，建站、上传材质、出图、启用官方插件、上传插件包并在 plugin host 里运行、各页面都正常，日志里没有写入失败。Next 运行时不往 `.next/cache` 写东西（没有 ISR，图片优化关着），不需要 tmpfs。运行时写的都在 `/data` 下：库、材质、出图缓存、插件包和解压出来的插件。
  - **停止**：`docker stop` 经 tini 转给启动器，0.2 秒内按顺序停下，退出码 0。在容器里强杀核心，启动器重新拉起它，旧的 plugin host 过继给 tini 后被回收，没有僵尸进程。
  - **健康检查**加了 `--start-interval=2s`，启动 4 秒后就是 healthy。容器里的 `nextskin doctor` 全部通过。
  - **数据目录**：绑定挂载一个 root 的目录时以 78 退出，报错里带当前的 uid（1000），部署文档写 `chown 1000:1000`。用命名卷没有这个问题：卷第一次挂载时继承镜像里 `/data` 的属主。
  - **反向代理和客户端 IP**：宿主机上的反向代理经发布的端口连进来，容器看到的对端地址是这个网络的网关（默认网桥是 `172.17.0.1`，compose 项目各有自己的网段），不是回环地址；外部客户端直接连进来时 Docker 做 DNAT，保留真实的来源地址。所以只把网关地址加进 `network.trustedProxies` 是安全的；不加的话所有访客的 IP 都是网关，按 IP 的注册限制和限流对所有人一起生效。compose 示例和部署文档都写明这一步。`X-Forwarded-Proto` 不受影响。
  - **构建**：Dockerfile（`packages/launcher/docker/`）不用 heredoc、`COPY --chmod` 这类 BuildKit 专有的写法，没有 buildx 的机器也能构建。只逐项复制发行目录的六个顶层条目，本地运行过的发行目录里的 `.env`、`data/` 不会进镜像。镜像解压后 449 MB，其中基础镜像 378 MB。
  - **CI**：冒烟测试写成 `packages/launcher/docker/smoke.sh`（构建；没给密钥退出 78；只读的根文件系统下启动到 healthy；`doctor`；`docker stop` 后退出码 0）。CI 的 e2e 任务和发布工作流的构建任务都跑它，基础镜像的升级在 CI 里先验一遍。
  - **推送和标签**：发布任务在批准后用 buildx 构建两种架构、推 `X.Y.Z`，再建草稿。`release-image-tags.yml` 在草稿发布后加 `X.Y`、`X`、`latest`，只在这个版本是对应范围里最新的正式版时才移动那个标签，给旧的次版本发修订版不会把 `latest` 指回去。两个发布工作流的并发组都加了 `queue: max`：默认只留一个排队中的运行，接连发布几个版本时后来的会顶掉排队的那个，它的标签就加不上（Codex 审核发现）。actionlint 1.7.12 还不认识这个键，GitHub 文档里有。
  - **GHCR**：第一次推送时建出 `nextskin` 包，私有仓库下它也是私有的；仓库公开时要在包的设置里一并改成公开。
  - compose 示例在 `docs/deploy/compose.yaml`：密钥从同目录的 `.env` 取，缺了 compose 直接报错；端口只绑 `127.0.0.1`；命名卷；`stop_grace_period: 40s`。实测起停正常。）

### 发布流程

维护者在本地改 `packages/launcher/package.json` 的版本号，提交到 main，再推 `vX.Y.Z` 标签。标签触发发布工作流：

1. **核对**：标签和版本号一致，标签指向的提交在 main 上。
2. **构建和测试**（不需要批准）：
   - Node 26 上 `pnpm install --frozen-lockfile`、`pnpm build`、`pnpm e2e`，测的就是要发出去的这份发行目录；
   - 打 ZIP，算 `SHA256SUMS`，作为工作流产物上传。
3. **Windows 冒烟**（不需要批准）：在 Windows runner 上用 PowerShell 的 `Expand-Archive` 解压 ZIP，跑 `doctor`，再 `start`、请求健康检查、停止。
4. **发布**（environment `release`，维护者批准后才运行）：
   - 把镜像按 `X.Y.Z` 推到 GHCR；
   - 建一个草稿 GitHub Release，附上 ZIP 和 `SHA256SUMS`。

之后的步骤：

- **草稿和 `latest`**：维护者写完发布说明，手动发布草稿。发布这个动作触发另一个小工作流，给镜像加上 `X.Y`、`X`、`latest`（预发布不加）。这样 `latest` 不会早于发布说明出现。
- **发布说明必须写**：
  - 对应的 Node 和 Next 版本，有没有安全修复（ADR-0013）；
  - 有没有迁移，有就提醒先备份，升级后回不去；
  - 不兼容的部署变化。
- **工作流的写法**：第三方 action 固定到提交 SHA，同 `ci.yml`。
- **校验**：
  - 每个版本都发 `SHA256SUMS`。
  - 仓库公开以后，ZIP 和镜像再加构建来源证明（`actions/attest-build-provenance`）。私有仓库要 GitHub Enterprise Cloud 才能用。

### 升级

- **程序文件**：
  - 步骤：停服务 → 删掉 `server/` 和 `cli/` → 把新包解压覆盖 → 启动。迁移在核心打开时执行（ADR-0039）。
  - 要先删再解压：只覆盖不删的话，旧版本有、新版本没有的文件会留下来。
  - 镜像就是换标签、重建容器。
- **版本核对**：组装时把版本号写进 `server/` 里的一个标记文件。
  - `start` 发现它和启动器的版本对不上，就以 78 退出，说明发行目录只换了一部分，请重新解压完整的包；
  - `doctor` 也查这一项。
- **SQLite 升级前自动备份**：
  - **何时**：核心打开时（`openCore`，`migrate` 命令也一样）有要执行的迁移，而库里已经执行过迁移（不是空库），就在迁移之前做备份。
  - **怎么备份**：`VACUUM INTO` 到 `<数据目录>/backups/nextskin-<时间>-<第一个要执行的迁移>.sqlite`，只留最近 3 份。
  - **失败时**：备份失败（例如磁盘满）就不迁移，报错，核心打不开。站点停着等管理员，比在没有退路的情况下迁移好。
  - **材质文件不备份**：它们一经写入就不再改（不变量 3），回退时恢复库就够了。
  - **放在 `openCore` 里，不放进启动器**：启动器不连数据库（ADR-0039）；`pnpm dev`、命令行和核心走的都是 `openCore`。
- **MySQL、PostgreSQL 不自动备份**：库可能很大，备份方式也因主机而异。发布说明和部署文档提醒先用 `mysqldump`、`pg_dump` 备份，可以先用 `migrate` 单独升级库，再切流量。
- **回退**：停服务，换回旧版本的程序文件，把备份的库放回原位置，再启动。
- （落地时补充，2026-10-20：
  - **独立的只读连接**：备份不经过核心的 Kysely 连接，而是对库文件另开一个 `node:sqlite` 的只读连接执行 `VACUUM INTO ?`。核心的 SQLite 方言用 authorizer 拦住原始 SQL 里的事务控制，`VACUUM INTO` 内部的事务也会被拦下；放宽这道保护不值得。实测只读连接能读到写连接还没 checkpoint 的 WAL 数据，生成的是不带 WAL 的独立文件。`:memory:` 的库不备份。
  - **写入**：先 `VACUUM INTO` 到备份目录里本次专用的临时文件（`.nextskin-backup-<随机>.partial`），成功后改名成正式文件名，同名的直接替换。失败时只删自己的临时文件：既不会留下写了一半、名字却像备份的文件，也不会删掉别的进程同一秒做好的备份（Codex 审核用两个进程复现过后者）。进程在中途被杀留下的临时文件，下一次备份成功时清掉超过 1 小时的。
  - **时间**用 UTC（`20261020T194512Z`），文件名按字典序就是时间顺序。清理只认这个命名规则的文件，管理员自己放进去的文件不动；本次的备份无论如何保留，另外只留最新的 2 份，系统时间回拨也不会删掉刚做的那份。清理失败只警告。
  - **失败**抛 `MigrationBackupError`，文案只有路径，可以原样打印：核心打开失败时 instrumentation 平时只打印 `[core] open_failed`（异常里可能带连接串），遇到它就带上文案；`migrate` 命令同样打印它，退出码 1。实测发行目录下 `backups` 被一个文件占住时，日志写明原因，健康检查返回 500，库停在原来的迁移。
  - **重试**：核心打开失败后每个请求都会重新打开一次（`apps/web/lib/server.ts`），为了管理员修好问题后不用重启。所以同一个进程里已经为同一批迁移备份过，就不再备份（核心没打开过，这个进程没改过库）；备份失败后 1 分钟内直接抛出上次的错误。否则迁移本身失败时每个请求都要把整个库拷一遍，"只留 3 份"还会挤掉上一次升级的还原点。实测：备份失败后挪开障碍，1 分钟后的请求自己恢复，先备份再迁移，不用重启。记录只在内存里：核心打不开期间手工改过库，要重启服务才会重新备份，沿用时的日志写明这一点。
  - **没有锁住整个升级**：备份和迁移之间，别的进程仍能写入；备份前判断"是不是空库"和迁移器拿锁之间也有空隙。前提是升级时没有别的进程在写这个库：同一个数据目录只能运行一个 `start`（ADR-0039），命令行打开核心时同样先迁移。要在这些空隙里写入，得有不同版本的进程同时打开同一个库，不为它加锁。
  - **回退**时要连同库旁边的 `-wal`、`-shm` 一起删掉：把备份复制回去而留着新库的 WAL，SQLite 会把新库的页面重放到旧文件上。ZIP 里的 README 已写明。）

### 部署文档和面板

- 部署文档放在 `docs/deploy/`，每种方式一页：宝塔、1Panel、Docker、systemd、Windows。ZIP 里的 README 指向它。
- **systemd 单元示例**：
  - `ExecStart=/usr/bin/node /opt/nextskin/nextskin.mjs start`
  - `KillMode=mixed`：默认的 `control-group` 会把 SIGTERM 同时发给启动器、核心和 plugin host，核心会跳过"先收任务"直接关 HTTP；`mixed` 只把 SIGTERM 发给启动器，到时才强杀其余进程。（落地时补充：核心和 plugin host 已经能应付整棵进程树一起收到 SIGTERM（ADR-0039"停止"），默认的 `control-group` 也会先收任务；示例里仍写 `mixed`，停止的过程只有启动器一个入口。）
  - `TimeoutStopSec=40`
  - `Restart=on-failure`、`RestartPreventExitStatus=78`
- **Windows**：在控制台里运行 `node nextskin.mjs start`，Ctrl+C 停止（ADR-0039）。做成服务时用会发 Ctrl+C 的包装工具（例如 NSSM），在文档里写配置。
- **宝塔、1Panel 要实测的**：
  - 启动命令：`node nextskin.mjs start`，还是发行目录 `package.json` 里的 `npm start`；
  - 端口从哪个环境变量给，工作目录是哪里；
  - 停止时发什么信号、等多久。宝塔的 Node 项目如果经过 pm2，pm2 默认只等 1.6 秒（`kill_timeout`）就强杀，文档里要写怎么调长；
  - 实测结果写进部署文档和这份 ADR 的落地补充。
- （落地时补充，2026-10-20 实测宝塔 13.0 的"Node 项目"和 1Panel v2.4.0 的"运行环境 → Node.js"，都用 Node 24：
  - **宝塔**：
    - 启动选项列出 `package.json` 里的脚本，选 `start` 就是 `npm run start`，不经过 pm2。发行目录的 `package.json` 没有 `dependencies`，宝塔不要求 `node_modules`。
    - 每次启动前把项目目录 `chown` 给运行用户（默认 `www`），启动器以 `www` 生成 `.env`（600）、建数据目录，没有权限问题。
    - 项目设置里的"环境变量"不会导出给进程（启动脚本里那一段是空的），"端口"只用于 nginx 反向代理和放行防火墙，也不传给进程。端口、监听地址只能写进 `.env`，和宝塔里填的端口一致。
    - 停止：给 pid 文件里的进程和全部子孙各发一次 SIGTERM，不等、不发 SIGKILL，0.5 秒后再给工作目录是项目目录的 node 进程发一次。重启是停止后立即启动。于是核心接管了 Next 的信号处理、plugin host 忽略 SIGTERM、`start` 拿不到锁时最多等 40 秒（ADR-0039"停止""启动前检查"）。实测核心先收任务、再退出；用一条发了一半请求头的连接拖住旧核心再重启，新的启动器等了约 30 秒（旧启动器到时强杀了核心）后正常启动。
    - 反向代理模板写的是 `proxy_set_header Host $host:$server_port`，不带 `X-Forwarded-Proto`。协议端点按 BS 的规则从 `Host` 和 `X-Forwarded-Proto` 算站点地址（`requestRoot`），HTTPS 站点会算成 `http://域名:443`。部署文档要写明把这两行改成 `Host $host` 并加上 `X-Forwarded-Proto $scheme`。`X-Forwarded-Proto` 不看受信任的代理；`network.trustedProxies` 默认就信任回环地址，同机的 nginx 不用另配。这台测试机的 80、443 被别的服务占着，宝塔没有装 nginx，这一条只读了模板、模拟了请求头，没有经过真实的 nginx。
  - **1Panel**：
    - 应用商店里的 Node 只到 25.9.0，没有 26；24.15.0 能运行（迁移、建站页、健康检查都正常），启动时提示 24、25 拦不住插件直接连网。
    - 运行环境是一个 `1panel/node` 容器：代码目录挂到 `/app`，"环境变量"写进 compose 的 `environment`，能传到进程；`.env` 和数据目录在代码目录里，删掉、重建容器后都还在。
    - 容器的 PID 1 是 `bash /run.sh`，它再执行 `npm run <脚本>`。停止（`docker compose down`）只给 PID 1 发 SIGTERM，bash 不转发，10 秒后整个容器被 SIGKILL，NextSkin 没有机会停。启动命令要选"自定义"，填 `exec node nextskin.mjs start`：`run.sh` 用 `eval` 执行它，启动器替换掉 bash 成为 PID 1，停止时 1 秒内按顺序退出、退出码 0。"安装依赖"关掉，否则每次启动都跑一遍 `npm install`。
    - 端口映射默认绑 `0.0.0.0`，Docker 发布的端口绕过 ufw。前面有 1Panel 的 OpenResty 反向代理时，部署文档建议改绑 `127.0.0.1`。
    - 安装 1Panel 会在 ufw 里放行面板端口；启动后 ufw 最前面还出现了带 `1panel-rule` 注释、对所有来源放行 80、443 的规则，卸载时都不删。这和 NextSkin 无关，但部署文档里要提醒已有防火墙规则的服主检查。）
- （落地时补充，切片四：
  - 部署文档写给服主和替服主操作的 agent，只写事实、命令和已知的坑，没实测的条目标"未实测"；面向用户的文档站另建。
  - **nginx**（2026-10-20 用宿主机网络的 nginx 容器、自签证书实测）：`Host $http_host` 加 `X-Forwarded-Proto $scheme`，在 8443 端口上得到 `https://skin.example.com:8443/api/yggdrasil`；照宝塔模板的写法得到 `http://skin.example.com:8444/…`。文档用 `$http_host`，不用上面写的 `$host`：`$host` 不带端口，站点不在标准端口上时端口会丢。nginx 默认的 `client_max_body_size 1m` 让 3 MB 的上传返回 413，`12m` 通过（插件包上限 10 MB）。
  - **宝塔会重写反向代理配置**：读面板源码，添加项目、修改项目设置、添加或删除域名、开关外网映射时都按模板重新生成 `node_<项目名>.conf`，手改的内容会丢。文档写明这些操作之后重新改；申请证书会不会重写没有核对。
  - **systemd**：用户级临时单元带上示例里的 `KillMode=mixed`、`TimeoutStopSec=40`、`Restart=on-failure`、`RestartPreventExitStatus=78`。正常停止 46 毫秒、退出码 0；强杀启动器后 systemd 清掉剩下的核心再重启，3 秒恢复；退出码 78 停在 failed、不重启。单元文件的 `User=`、开机自启没有实测。
  - **Docker 文档里的命令**：目录挂载属于 root 时退出 78、报 uid 1000；用 `debian` 镜像打包数据卷、用镜像里的 `sh` 在卷里换回备份都可行。顺带发现正常停止后 `nextskin.sqlite-wal` 还在：核心退出时不关数据库，SQLite 下次打开时重放。文档写明手工备份要停服务、拷整个数据目录。
  - **受信任的反向代理**：网关地址随部署方式变（默认网桥、Compose 网络、`1panel-network`），文档不让服主猜，改为看审计日志里自己登录的 IP，是内网地址就把它加进去。
  - **Windows**：Ctrl+C 的停止顺序没有在真实控制台里实测（发布工作流的 Windows 冒烟最后用 `taskkill /F`）；NSSM 的配置照它的文档写，标了未实测。）

### 下载渠道

先只发 GitHub Releases 和 GHCR。国内访问这两处都慢，国内的镜像仓库、对象存储这类渠道等第一版发出、看用户的反馈另行决定。`SHA256SUMS` 让任何渠道分发的包都能核对。

### 不做

- **自动检查更新**：要让站点向外报到，另行决定。
- **带 Node 的包**：ADR-0039 已定。
- **降级迁移**：回退靠备份。

### 落地

分四个切片：

1. **ZIP 包和发布工作流**：
   - 摊平 `node_modules`，产物检查（没有链接、没有 `.node`）；
   - 版本号写进发行目录和 `server/`，`start`、`doctor` 核对；
   - ZIP 里的 README；
   - 发布工作流：核对、构建、e2e、ZIP、`SHA256SUMS`、Windows 冒烟、草稿 Release。
2. **镜像**：
   - Dockerfile 和 compose 示例；
   - 发布工作流里推 GHCR，发布以后打标签；
   - 验证只读的 `/app`、停止顺序和健康检查。
3. **SQLite 升级前自动备份**。
4. **部署文档**：宝塔、1Panel 实测。

## 后果

- ZIP 包在 Windows、Linux、macOS 上直接解压就能运行，Windows 资源管理器解压也不会撞路径长度的上限。
- 组装脚本多一段摊平依赖的逻辑。哪天依赖里出现同名包的两个版本，构建会失败，到时候要补嵌套。
- 产品版本号和 SDK 版本号各走各的：SDK 由 changesets 管，产品由维护者手改。
- 每个版本的发布都要维护者批准一次、手写一次发布说明。
- SQLite 的站点每次带迁移的升级都会在 `data/backups/` 多一份库的拷贝，最多留 3 份。
- 镜像要求部署方在环境变量里给出密钥，不会自动生成。

## 考虑过的其他方案

- **保留符号链接，POSIX 发 tar.gz，Windows 另想办法**：两种包、两套文档，Windows 上的问题没有解决。
- **启动器第一次启动时按清单重建链接**：Windows 上只能建 junction，会撞上背景里说的绝对路径和权限问题，还要求发行目录可写。
- **组装时把链接换成目标的拷贝**：同一个包会出现在几个位置，Node 按真实路径各加载一份。next、react 有进程级的单例（请求上下文、React 的内部状态），加载两份会出错。
- **发版时用 pnpm 的 hoisted 布局重新安装、再构建**：发版和日常 CI 的依赖布局不同，测的不是同一个东西；Turbopack 的 hash 别名照样是链接。
- **镜像用 alpine**：见上文"镜像"。
- **不放 tini，靠 `docker run --init` 或 compose 的 `init: true`**：面板的 Docker 界面不一定有这个选项。
- **产品也用 changesets 管版本**：见上文"版本号"。
- **ZIP 的顶层目录带版本号，升级时解压到新目录，再把 `.env` 和 `data/` 挪过去**：面板里的项目路径每次都要改，挪漏了 `.env` 还会丢掉密钥。
- **迁移前备份放进启动器**：见上文"升级"。
