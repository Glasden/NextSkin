# 管理进程（ADR-0061 切片三、四）

源码入口是 `src/main.ts`，供发行目录的构建任务打成 `manager/main.mjs`；根入口复制 `release/nextskin.mjs`。本包只依赖 Node 内置模块、`@nextskin/updates` 和 `fflate`。不读取 `.env`，数据库信息只从版本自己的 `doctor --json` 取得。

`createManager(options): Promise<Manager>` 在 `src/pipeline.ts`，公开类型在 `src/types.ts`：

```ts
interface Manager {
  status(): InternalManagerStatus
  check(): Promise<ReleaseEntry[]>
  prepare(version: string): Promise<Preflight>
  prepareLocal(version: string, options?: { from?: string; legacy?: boolean }): Promise<Preflight>
  apply(version: string, options?: { backupConfirmed?: boolean }): Promise<UpgradeResult>
  rollback(options?: { confirmed?: boolean }): Promise<UpgradeResult>
  cancel(): void
}
```

`prepareLocal` 供管理进程处理手动解压的发行包；控制通道只暴露 prepare，由管理进程选择是否走 prepareLocal。`check`、准备、切换和回滚互斥；`status` 随时返回独立副本，`cancel` 只中止正在准备的操作。准备失败抛出带 `code` 的 `ManagerError`（默认 `internal`）；已经开始的切换或回滚返回持久化的结果，包括失败结果。没有准备目标、缺少备份确认、没有 previous、备份缺失或已有操作时直接拒绝，不写失败记录、不标记失败版本，保留 prepared。`failed` 只记开始迁移以后的失败（迁移失败、新版本没通过健康检查）；准备失败（下载、空间、Node、管理进程协议、预检）和迁移之前的失败（等数据锁超时、停站后要重新确认备份）只写 lastResult 和日志。

`InternalManagerStatus` 包含 `current`、`previous`、`operation: { kind, version, step, startedAt, progress? } | null`、`prepared: Preflight | null`、`lastResult: UpdateLog | null`。操作 kind 为 `check | prepare | apply | rollback`。`Preflight` 包含目标版本、绝对数据目录、SQLite 文件路径（其他数据库为 null）、方言、待执行的核心和插件迁移数组、不兼容插件数组，以及 `tier: none | sqlite | external-backup`。

指针完整格式如下（全新安装也写空的 failed 和 upgrades）：

```json
{
  "schema": 1,
  "current": "0.5.0",
  "previous": "0.4.0",
  "bundled": "0.5.0",
  "failed": [],
  "upgrades": {
    "0.5.0": {
      "from": "0.4.0",
      "migrations": true,
      "dialect": "sqlite",
      "backup": "/instance/data/backup.sqlite"
    }
  }
}
```

`previous` 和 `backup` 可以为 null；方言为 `sqlite | mysql | mariadb | postgres`。指针损坏是配置错误（78），不能推断。previous 非空时必须有对应的升级记录，避免把未知迁移误当成无迁移。写入采用临时文件加改名，EPERM、EBUSY、EACCES 最多尝试 10 次。

`UpgradeResult = UpdateLog`；日志每行一个 JSON：

```ts
interface UpdateLog {
  at: string // UTC ISO 时间
  kind: 'update' | 'manual' | 'legacy' | 'rollback'
  from: string
  to: string
  result: 'success' | 'rolled-back' | 'failed'
  step: number // ADR 流水线的 1–11
  reason?: string
  migrations?: boolean
  backup?: string | null
  error?: { kind: string; message: string } // migrate 报的错误，原样保留
}
```

实现上的判断：

- 第 2 步先执行当前版本的只读 doctor，取得 SQLite 文件大小；第 5 步再用目标版本预检。分别检查程序和数据库所在的文件系统，解压空间按 ZIP 的 3 倍估计。
- apply 停站前重新预检；迁移、路径或插件情况发生变化时要求重新准备，不能沿用过期的备份档位。外部数据库没确认备份时，拿到数据锁后再预检一次，停站期间新出现的迁移（在途请求启用了插件）不执行，换回旧版本。
- 停启动器超时（35 秒）就强杀，`ready` 里带核心的 pid，连核心一起杀，最多等 5 秒确认它退出再拿数据锁；没有 pid 时只能记日志。
- 迁移失败时先判断库变没变：`migrate --json` 的失败报告带已提交的核心迁移和备份路径；报告里没有已提交的迁移（插件迁移逐条提交、不在报告里，或者进程崩溃、超时）时，持锁再跑一次目标版本的 doctor，比较待执行的迁移。SQLite 有备份就换回再起旧版本；变了而没有备份、或者外部数据库变了，指针留在新版本；判断不了就起旧版本（它的迁移器拒绝不认识的迁移），说明里写明。
- 手动解压的外部数据库版本有迁移时，保留 prepared 和版本目录、继续启动 current，提示先备份，再在后台确认或停服运行 `node nextskin.mjs update --backup-confirmed`。离线 `update` 不带 `--to` 时，比 current 新的自带版本已经解压在 `releases/` 里就升到它，不读清单。
- 旧布局升级失败退出 78，不创建指向旧布局的 current.json，失败记在日志里，旧程序保留，提示照 ADR-0040 手工回退。SQLite 在迁移成功而健康检查失败时恢复备份。旧布局不能由管理进程启动。外部数据库有迁移时不迁移、同样退出 78，停服运行 `update --backup-confirmed` 完成切换（目标只能是自带版本），成功后删掉 `server/`、`cli/`。
- 管理进程运行时根入口拒绝 `import`：切换时启动器放开数据锁到管理进程拿到之间有空窗。
- 管理进程协议分两个常量（`@nextskin/updates`）：`MANAGER_PROTOCOL` 是本管理进程支持的最高协议，`REQUIRED_MANAGER_PROTOCOL` 是本版本要求的、写进清单条目。prepare 遇到要求更高协议的目标以 manager_outdated 拒绝，按顺序说明：`manager.next/VERSION` 比本管理进程新就提示重启；清单里有比 current 新、协议兼容的版本就提示先升到其中最新的；都没有就只能覆盖解压。
- 外部数据库有迁移的回滚只在服务停着时由命令行执行：控制通道以 offline_required 拒绝（服务运行时恢复库，新版本还在写库，核心被拉起还会把恢复的库再迁移一遍）。离线回滚照旧先用目标版本 doctor 核对库已恢复，再改指针；拿不到数据锁（服务其实还在运行，比如 `NEXTSKIN_MANAGER=off`）同样以 offline_required 退出，不起任何程序，提示停服后再恢复一次库。核心也按 `rollback` 状态先拒绝，不把请求转给可能更旧的管理进程。
- 根入口一键升级送不到：管理进程和它之间只靠 `manager/main.mjs`、`manager/VERSION`、`manager.next/VERSION`、`NEXTSKIN_MANAGER`，改动要向前兼容。
- SQLite 回滚在恢复备份之前用当前版本 doctor 取得数据路径；目标旧版本此时可能因为库比它新而拒绝预检。外部数据库回滚则用目标版本 doctor 检查管理员已恢复的库。SQLite 回滚在换回备份之前失败（等数据锁超时之类）时库还没动，照旧起当前版本，不让站点停着。
- 健康检查通过后不因记录或清理失败自动回滚：此时已经可能接受用户写入。待生效管理进程移动失败时保留 staging，提示管理员检查权限。
- 流式解压前逐条读取 ZIP 中央目录检查 Unix 链接属性；不支持 ZIP64、分卷和加密包，解压总大小上限 4 GiB。也拒绝 Windows 特殊文件名、尾随点和空格、控制字符和 ADS 路径。
- 根入口换代删除 manager.old 前复制到临时的 manager.recovery，递归删除中途失败也能恢复完整旧程序；完成后删除冗余副本。恢复本身也被系统拒绝时提示人工恢复。
- 只读目录不能创建 manager.lock，因此先检查可写性；只读模式监管确定的版本，不做升级。off 模式连锁和清理也不执行，根入口同样不换 manager.next。

`Runtime` 和 `ManagerOptions` 支持注入 spawn、fetch、时钟、等待、日志、命令、锁、空间和时长。测试用临时实例、真实假启动器子进程和本机 HTTP 服务；清单和 ZIP 的 fetch 全部注入，不访问公网、不依赖 dist 或 Docker。

验证命令：

```bash
pnpm test packages/manager
pnpm --filter @nextskin/manager typecheck
pnpm exec eslint packages/manager
pnpm exec prettier --check packages/manager
```

发行目录组装由后续任务完成。Windows 改名重试、删除部分失败的恢复由注入故障覆盖，实际 Windows 命名管道、控制台、NSSM 和杀毒软件占用仍需要在对应系统实测。

## 控制通道

`src/control.ts` 提供服务、命令行客户端及 `managerStatus` 转换。调用方先持有 `manager.lock`。POSIX 地址是实例目录下的 `releases/manager.sock`；绝对路径超过 100 字节时改用 `os.tmpdir()/nextskin-<hash>.sock` 并打印说明。hash 是实例绝对路径的 SHA-256 前 16 位。Windows 地址是 `\\.\pipe\nextskin-<hash>`。Node 无法给命名管道设置 ACL，Windows 安全只靠随机令牌。

每次启动生成 32 字节随机令牌，十六进制写入 `releases/manager.token`，先写临时文件再改名。POSIX 令牌和 socket 均为 0600。启动前删除残留 socket，正常退出、启动失败及收到停止信号时关闭服务并删除 socket 和令牌。SIGKILL 等不可捕获的退出留下的文件在下次启动时替换。只读模式不开控制通道、不写令牌。

只有 `LauncherSupervisor` 的 `start` 获得 `NEXTSKIN_MANAGER_ADDRESS`、`NEXTSKIN_MANAGER_TOKEN`；`doctor` 和 `migrate` 会剔除从外层继承的同名变量。令牌不进日志。

一次连接一个请求和一个响应，都是以 `\n` 结尾的单行 JSON，最大 64 KiB；请求不完整超过五秒或超长直接断开。请求必须正好是 `{ token, method, params }`，params 也严格拒绝额外字段和错误类型。令牌用 `timingSafeEqual` 比较。响应为 `{ ok: true, result }` 或 `{ ok: false, error: { code, message } }`，message 为中文。

| 方法     | params                                          | 同步检查及结果                                                                                                                       |
| -------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| status   | `{}`                                            | 返回线上 `ManagerStatus`                                                                                                             |
| prepare  | `{ version: string }`                           | 格式、busy、readonly；立即返回 `{ accepted: true }`，后台读取签名清单和准备；目标为已解压的 bundled 且比 current 新时走 prepareLocal |
| apply    | `{ version: string, backupConfirmed: boolean }` | 格式、busy、readonly、not_prepared、backup_required；写完 accepted 并关闭连接后才切换                                                |
| rollback | `{ confirmed: boolean }`                        | 格式、busy、readonly、no_previous（含目录缺失）、offline_required、confirmation_required、backup_missing；写完 accepted 并关闭连接后才回滚 |
| cancel   | `{}`                                            | 只有准备中调用 cancel，返回 `{ cancelled: boolean }`                                                                                 |

所有方法都可能返回 unauthorized、invalid_request；非预期异常返回 internal。prepare 后台错误进入日志和 lastResult。流水线保留 not_newer、unknown_version、manager_outdated、node_too_old、preflight_failed、download_failed 等错误码；预检包括 unknownCore、空间不足、doctor 失败或超时；下载错误包括清单读取、大小、SHA-256、解压及发行包校验失败。本地已解压目录不完整归为 preflight_failed。

线上类型定义在 `src/types.ts` 的 `ManagerStatus`，与内部 `InternalManagerStatus` 分开：包含 protocol、pendingManager（`manager.next` 或 `manager` 里比本管理进程新的版本，没有为 null；服务运行时执行命令行，根入口会把 manager.next 先换进 `manager/`）、version、current、previous、writable、operation、prepared、lastResult、failed、rollback。步骤编号转为 manifest / space / download / extract / preflight / confirm / stop / migrate / switch / start / cleanup；check 对外为 null。下载进度是 `{ received, total }`，total 来自签名条目的 size。mariadb 映射成 mysql，待执行迁移数组转为条数。rollback 由 previous 和 upgrades[current] 得出，仅暴露 SQLite 备份是否存在；不暴露数据目录、SQLite 文件或备份路径；`lastResult.reason` 和错误响应的 `message` 里的绝对路径换成 `<路径>`，完整的说明留在 `update-log.jsonl` 和管理进程的日志里。

## 命令行

根入口处理多传的 `--`，符号链接入口按 realpath 判断是否直接执行。help 先打印管理命令，再转给当前启动器。

| 命令                                                | 输出及行为                                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `update status [--json]`                            | 运行时读控制通道；停服时读 current.json 和 update-log.jsonl，输出当前、上一个版本及最近结果；JSON 使用线上状态格式              |
| `update --check [--json]`                           | 本进程按 Manager.check 的签名和版本逻辑列出较新的正式版，不拿锁；要求更高管理进程协议的版本在文本行末标注；JSON 为版本条目数组 |
| `update [--to <版本>] [--yes] [--backup-confirmed]` | 默认最新的协议兼容的正式版（最新的要求更高协议时先输出一行说明）；运行时 prepare 后每 500ms 轮询步骤和下载字节，展示预检、迁移数、不兼容插件及停站估计，然后确认 apply 并轮询结果 |
| `rollback [--yes]`                                  | 只回 previous；SQLite 有迁移明确提示“升级以后的所有写入都会丢失”；外部库有迁移时服务运行中直接拒绝（offline_required），服务停着时要求库已用升级前的备份恢复，成功后提示启动服务 |
| `releases [--json]`                                 | 列出版本目录，标记 current、previous、bundled、failed 和管理进程是否运行；JSON 为 `{ running, releases }`                       |

有 external-backup 迁移而没有 `--backup-confirmed` 时退出 1。没有 `--yes` 时只在 TTY 上询问一次 y/N；非 TTY 必须显式 `--yes`，拒绝或取消退出 1。`--yes` 在 rollback 中表示确认数据库恢复要求。

服务停着时先拿管理进程锁，拿不到说明另一管理进程运行而控制通道不可达，退出 1。离线命令复用流水线，supervisor 的 start、stop、resume 均不启动进程：**服务停着时 update 只迁移和切换，不做健康检查**，rollback 同样如此。命令行等数据锁最多 5 秒（管理进程监管时是 40 秒，等启动器放锁），拿不到多半是服务以别的方式在运行。运行时的 update 按管理进程报告的协议挑默认目标，不按命令行自己的。

参数经 `node:util.parseArgs` 严格解析。成功和只读查询退出 0；用法错误、升级失败、自动回滚或取消退出 1；损坏指针、实例目录不可写和锁文件无法创建等配置错误退出 78。此处“不做健康检查”只针对停服命令，在线切换仍等待健康检查。

测试只用临时实例、注入的清单和下载、本机 socket / HTTP 及假启动器。TTY 确认通过注入输入验证；真实终端的 Ctrl+C、EOF、Windows 控制台和命名管道尚未实测。

## 权限分离（POSIX，可选）

设 `NEXTSKIN_RUN_AS=<服务用户名>` 时，管理进程以 root 运行，`nextskin.mjs`、`manager/`、`releases/` 归 root，服务用户只能读取和遍历程序目录；`.env`、`data/` 归服务用户。root 必须保留降权及改归属所需的能力（包括 CAP_SETUID、CAP_SETGID 和 CAP_CHOWN）。releases 的可写性仍按管理进程自身身份判断，不按服务用户判断。

start 和停服执行的 update / rollback 用 `id -u <用户名>`、`id -g <用户名>` 解析 uid/gid，走 NSS，不直接读 passwd 文件。用户名必须符合 `^[a-z_][a-z0-9_-]{0,31}\$?$`（大小写不敏感）。名称不合法、id 失败或返回非法编号、Windows 上设置此变量，均是配置错误（78）。非 root 进程不能切换到其他 uid；目标 uid 就是当前用户时等同于没设。

启动时仅打印一行 `以 <名字>（<uid>/<gid>）运行服务`，不打印其他环境。启动器的 start、管理进程调用的 doctor 和 migrate 均通过 spawn 的 uid/gid 降权；libuv 同时清除附加组。降权子进程删除 HOME、USER、LOGNAME，避免继承 root 的用户目录和身份；不额外运行 getent，也不猜测用户的 home 路径。

socket 改为 root:服务用户主组、0660，核心可以连接，同组以外不能连接；令牌仍为 root 所有、0600。核心只经环境取得令牌。未分离时 socket 保持 0600。

SQLite 恢复先复制到临时文件，改归服务用户的 uid/gid，再复制被替换库文件的权限后改名；目标库已不存在时使用 0600。数据锁用独占创建区分新旧文件：新建的 `dataDirectory/nextskin.lock` 改归服务用户，现有锁不改归属。manager.lock 在程序目录内，始终归管理进程。

**node:sqlite 的空锁库在 BEGIN EXCLUSIVE 时确实会创建 `-journal`**。分离模式的数据锁先设 `PRAGMA journal_mode=MEMORY`，不提交数据库内容，不产生 root 的 journal / wal / shm 旁路文件；未分离时锁实现保持原样。测试在真实 SQLite 持锁和释放时检查目录，并验证另一进程在持锁期间退出 78、释放后能正常启动。

服务停着时由命令行执行的 update / rollback（`checkDataOwner`），以 root 运行而没有有效的降权身份时，doctor 返回的数据目录若不属于 root，流水线拒绝继续并报配置错误（78），不把它记成目标版本失败：运行命令的用户不一定是平时运行服务的用户，root 的迁移会在数据目录里留下服务读写不了的文件。常驻的管理进程不查：没有降权时它拉起的服务和迁移都是 root，容器里以 root 运行、数据目录挂自宿主机其他 uid 的部署照常能用。

管理进程不读 `.env`。systemd 单元中的环境不会自动传给单独运行的命令行；停服升级或回滚要显式传入，例如：

```bash
sudo NEXTSKIN_RUN_AS=nextskin node /opt/nextskin/nextskin.mjs update --yes
sudo NEXTSKIN_RUN_AS=nextskin node /opt/nextskin/nextskin.mjs rollback --yes
```

其他转给启动器的命令不自动降权，由管理员自行选择身份，例如：

```bash
sudo -u nextskin node /opt/nextskin/nextskin.mjs doctor --json
sudo -u nextskin node /opt/nextskin/nextskin.mjs set-role <邮箱> <身份>
```

NEXTSKIN_MANAGER=off 会在管理进程内直接加载启动器，无法保留 root 管理进程再单独降权。因此需要切换 uid 的 NEXTSKIN_RUN_AS 与 off 同用时拒绝启动（78）；目标就是当前用户时不受此限制。

权限测试注入 getuid、id、chown 和 stat，子进程选项测试在捕获 uid/gid 后仍以测试用户运行假启动器，不使用 sudo。真实 root 下的降权、附加组清除、socket 跨用户连接与拒绝、令牌 root 所有权以及恢复文件的真实归属，需要另在具备相应能力的 root 环境验证；LDAP/NSS 远端账号也未实测。Windows 命名管道、控制台和真实交互输入的未实测项与上文相同。
