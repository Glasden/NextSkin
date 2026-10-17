# S2：Kysely + node:sqlite 的功能、事务与并发

**结论：通过，不需要退回 better-sqlite3。** node:sqlite 在 Node 24.21 和 26.12 上都不再输出实验性警告，稳定性为 1.2（Release candidate）。核心要用的功能都可用：WAL、在线备份、defensive、limits、authorizer，崩溃测试也全部通过。better-sqlite3 同样是同步执行、同样无法中断查询，裸查询速度与 node:sqlite 相当，换过去解决不了任何并发问题。

S5 遗留的两个 SQLite 风险，答案都在连接架构上，与驱动无关：
- **事务挡住所有读**：用一写一读两个连接（WAL）解决。
- **插件慢查询阻塞事件循环**：插件的读查询放到一个独立的 worker 连接上，这个连接用 authorizer 限定只能访问该插件自己的表。

插件自己开的事务会占住全局写锁，任何架构都避免不了，只能靠很短的时限来约束。

对应 ADR：`docs/adr/0008-zero-native-deps.md`，以及 `docs/adr/0010-plugin-api.md` 中遗留的 SQLite 风险。

## 运行

```bash
npm ci
node src/probe.ts                       # 功能探测（Node 24 默认开启类型剥离，直接运行 .ts）
node src/micro.ts "$(node -e 'import("./src/schema.ts").then(m=>console.log(m.freshCopy("micro")))')"   # 单条查询的开销
node src/terminate.ts data/micro.db     # 失控查询能否中断
node src/crash.ts 20                    # kill -9 崩溃测试
taskset -c 3 node src/bench.ts          # 并发压测：服务进程绑 CPU 0-2，压测端在 CPU 3
npx tsc -p tsconfig.json
```

第一次运行时生成种子数据 `data/seed.db`（5 万用户、6 万角色、10 万材质、50 万衣柜条目、20 万插件表行），约 10 秒。

| 文件 | 内容 |
|---|---|
| `src/db/node-sqlite.ts` | node:sqlite → Kysely `SqliteDatabase` 的适配层：参数检查、语句缓存 |
| `src/db/pool-dialect.ts` | 多连接方言：一个写连接 + N 个读连接，连接可以在主线程，也可以在 worker |
| `src/db/sqlite-worker.ts` | worker 里的连接；`plugin` 角色装 authorizer |
| `src/server.ts` | 压测用的 Hono 服务：CSL、hasJoined、join、衣柜、点赞，以及插件干扰 |
| `src/bench.ts` | 5 种架构 × 3 种干扰的并发压测 |
| `src/probe.ts`、`micro.ts`、`terminate.ts`、`crash.ts` | 功能探测、单条查询开销、中断实验、崩溃测试 |
| `repro/sqlite-3.54-clear-bindings.c` | SQLite 3.54 重复编译问题的最小复现（见下文） |

## 结果

### 1. 功能（Node 24.21 / SQLite 3.53.4，Node 26.12 / SQLite 3.54.0）

两个版本行为一致的部分：
- WAL；一个连接的写事务进行中，另一个连接能读到提交前的快照。
- `backup()` 在线备份是异步的，不阻塞事件循环。
- `defensive` 默认开启，`load_extension` 默认禁用。
- `limits` 可以在运行时调整。
- 外键约束默认开启。
- `setAuthorizer` 能拒绝读未授权的表，`pragma` 和 `attach` 也会被拒绝。
- 编译时开启了 FTS5、JSON、R*Tree、数学函数。

两个版本有差异的部分：

| 项目 | Node 24 | Node 26 |
|---|---|---|
| 类名 | `DatabaseSync` | 改名为 `Database`，`DatabaseSync` 是只在文档里标注弃用的别名（DEP0210） |
| 绑定 `undefined` | 报错 | 绑定为 NULL |
| `statement.stat()`（语句计数器） | 没有 | 有 |

适配层要统一处理上表中的差异，并规避以下几个坑：
- **第一个参数是对象时，会被当成命名参数表。** 如果开头的参数是 `Date`，它会被吞掉，后面的参数整体左移一位，写进错误的列，而且不报错。Better Auth 的 `NodeSqliteDialect` 直接把参数展开传入，所以会中招。S5 记录的"Date 被绑定成 NULL"就是这个现象。适配层的做法是固定在参数前面垫一个空对象 `{}`，这样 `Date` 会直接报错。
- 数组作为单个参数传入时，也会被当成命名参数表（报 `Unknown named parameter '0'`）。Kysely 自带的 `SqliteDriver` 是按 better-sqlite3 的习惯这样传的，所以必须经过适配层。
- 读取超过 2^53 的整数会报错。需要时对单条语句开 `setReadBigInts(true)`。
- boolean 会被绑定成 0/1。适配层显式转换，不依赖驱动的这个行为。
- 设了 busy_timeout 后，等待锁是**同步忙等**：另一个进程持有写锁时，主线程会被卡住整个超时时长（实测 200 ms）。

**不要用 Better Auth 的 `NodeSqliteDialect` 作为核心方言**，除了上面的参数错位问题，还有三点：
- 每次查询都重新 prepare，比带语句缓存的适配层慢约 30%；
- 编译器继承的是 `DefaultQueryCompiler`，不是 `SqliteQueryCompiler`；
- 不支持 savepoint，而核心需要用 savepoint 隔离拦截器的失败。

Kysely 0.29 的 `SqliteDialect` 加上一个不到 100 行的适配层（`src/db/node-sqlite.ts`）就够了。Better Auth 直接使用同一个 Kysely 实例。

### 2. 单条查询的开销（µs，Node 24，CPU 0-2）

| 方式 | 读（CSL 查询） | 写事务（2 条语句） |
|---|---|---|
| node:sqlite 直连 | 11.8 | — |
| better-sqlite3 直连 | 13.6 | — |
| Kysely + `SqliteDialect` + 本适配层 | 61 | 233 |
| Kysely + Better Auth `NodeSqliteDialect` | 92 | 269 |
| Kysely + better-sqlite3（Kysely 不缓存语句，better-sqlite3 的 prepare 较贵） | 138 | 366 |
| 读连接在 worker（串行 / 并发 32 时平摊到每次） | 132 / 63 | — |
| 写连接在 worker | — | 573 |

每次查询大约有 45 µs 花在 Kysely 构建和编译查询上，驱动本身的耗时很小。放到 worker 的读查询，串行延迟多约 70 µs（一次消息往返），但并发时吞吐不降。写连接放进 worker 后，事务里每条语句都要多一次往返，写事务的延迟翻倍以上。

**Node 26 的回归**：Node 26.12 内置的 SQLite 3.54.0 中，带 JOIN 的语句**每执行一次都会被重新编译**，单条 JOIN 查询从约 2 µs 变成约 9 µs。原因已用纯 C 程序定位：SQLite 3.54.x 遇到 `sqlite3_clear_bindings()` 后再绑定参数，就会重新编译 JOIN 语句（3.53.4 不会；去掉这个调用后，3.54.1 也正常）。node:sqlite 每次执行都会调用它。根因在 SQLite 源码里：3.54 新增了 `smimask` 规则，即参数在 0/1 和其他值之间切换时才重新编译；`sqlite3_bind_*` 遵守这条规则，`sqlite3_clear_bindings` 却仍然只要 `expmask` 非零就让语句过期。复现代码在 `repro/`。已向 Node 报告（[nodejs/node#66800](https://github.com/nodejs/node/issues/66800)），也已在 SQLite 论坛报告（[forumpost/e9fa3f80d5](https://sqlite.org/forum/forumpost/e9fa3f80d5)）。SQLite 已在 branch-3.54 上修复（check-in [535a77cf5a](https://sqlite.org/src/info/535a77cf5a8e1a7b)，2026-10-17，[drh 的回复](https://sqlite.org/forum/forumpost/b4f0958dac)），并合入 trunk：`sqlite3_clear_bindings` 改为和 `sqlite3_bind_*` 遵守同一条 `smimask` 规则。把这个补丁打到 3.54.1 上跑 `repro/`，JOIN 查询回到 0.65 µs，重新编译次数从 200000 次降到 8 次。截至 2026-10-17，还没有发布包含这个修复的版本（最新是 3.54.1），Node 26 要等升级内置 SQLite 后才会恢复正常。端到端影响很小，因为 Kysely 的开销远大于这几微秒，所以不影响结论。

### 3. 并发压测

Hono 服务，32 个并发连接持续压测 15 秒。请求组合：CSL 3、hasJoined 3、衣柜 2、join 1、点赞 1，即 20% 是写请求。服务进程绑在 CPU 0-2，压测端在 CPU 3。这台机器上同时运行着其他项目的服务。

两种干扰都在服务进程内模拟插件行为：
- **慢查询**：插件对自己的表做非等值连接，每次约 400 ms，循环执行；
- **长事务**：插件开事务、写一行、然后 `await` 200 ms（模拟事务里的一次 RPC 往返），循环执行。

| 架构 | 说明 |
|---|---|
| A | 一个连接，主线程（Kysely 默认做法） |
| B | 一写一读两个连接，都在主线程 |
| C | 写连接在主线程，2 个读连接在 worker，插件读查询与核心共用读连接 |
| D | 写连接和 2 个读连接都在 worker |
| E | 同 B；插件的读查询另走一个装了 authorizer 的 worker 连接 |

Node 26.12 的结果（Node 24 的规律相同，数据见 `data/results/`，该目录不进仓库）：

| 架构 | 无干扰 req/s · p99 | 插件慢查询 req/s · p99 · 事件循环延迟 p99 | 插件长事务 req/s · p99 |
|---|---|---|---|
| A | 2829 · 51 ms | **548 · 427 ms · 424 ms** | **628** · 250 ms |
| B | 2737 · 52 ms | **535 · 427 ms · 426 ms** | 1242 · 170 ms |
| C | 3875 · 49 ms | 3719 · 56 ms · 27 ms（Node 24 上 p99 为 349 ms） | 1241 · 205 ms |
| D | 3612 · 71 ms | 3295 · 79 ms · 8.5 ms | 1123 · 243 ms |
| E | 2757 · 51 ms | **2665 · 41 ms** · 39 ms | 1210 · 178 ms |

怎么读这张表：
- **无干扰时**，瓶颈是主线程上的 Hono、Kysely 和 JSON 处理，不在 SQLite。C 和 D 把 SQLite 的执行挪出了主线程，所以吞吐高 30–40%。表中 p99 和事件循环延迟都是饱和状态下的数值。自建站点的实际负载通常远低于这个水平。
- **插件慢查询**：A 和 B 下整个服务被拖垮，吞吐跌到五分之一，每个请求都要等那条查询结束。
    - C 把慢查询挪到了读连接所在的 worker，但核心查询有时也会被分到同一个 worker，排在慢查询后面。所以它的尾延迟时好时坏：Node 26 上 p99 是 56 ms，Node 24 上是 349 ms。
    - **E 让插件查询有自己专用的连接，核心完全不受影响**，各项指标与无干扰时一样。
- **插件长事务**：只有一个连接的 A 下，所有查询都要排队。B、C、D、E 里读不受影响，但写请求都排在插件事务后面，压测的每条连接都会卡在写请求上，所以吞吐减半。SQLite 只有一把写锁，这一点任何架构都改变不了。

### 4. 失控查询能否中断

node:sqlite 没有暴露 `sqlite3_interrupt`，也没有 progress handler。下表在 worker 里跑一条约 2 秒的插件查询：

| 办法 | 结果 |
|---|---|
| 直接 `worker.terminate()` | 中断不了，terminate 要等查询自己跑完（1.7–1.9 s） |
| 查询里带一个 JS 自定义函数，再 terminate | 3–4 ms 内结束 |
| 自定义函数自己检查期限并抛错 | 查询被中止，worker 继续可用 |

SQLite 把不带参数的函数放在最外层循环里求值，开销几乎为零，中止的精度是外层循环的一次迭代。强制让它在最内层求值（例如传入每张表的列）就能逐行检查，但同一条查询会慢 4.6 倍。

所以：插件查询由 S5 的网关在 WHERE 中加上 `ns_deadline()`，大多数查询可以按时中止。极端情况下（外层只有一行、内层很大），中止不了的查询只会占住插件专用的那个 worker，不会影响核心。这时网关放弃这个 worker，另起一个新的；被放弃的 worker 数量设上限。

### 5. 崩溃测试

在 WAL + `synchronous=normal` 下连续提交事务，在随机时刻 `kill -9`。Node 24 和 26 各 20 轮，全部通过：`integrity_check` 正常，已报告提交的事务都在库里，计数器与行数一致。断电时可能丢失最后几个事务，这是 `synchronous=normal` 的已知取舍，这里测不到。

## 建议的做法（写入 ADR-0008）

1. **方言**：在 `packages/db` 里实现多连接驱动（本 spike 的 `pool-dialect.ts` 是雏形）：
    - 底层用 Kysely 的 `SqliteQueryCompiler`、`SqliteAdapter`、`SqliteIntrospector`，加上本适配层；
    - 连接配置：一个写连接加一个读连接，都在主线程（架构 B），开 WAL 和 `synchronous=normal`；
    - 事务内的查询都走写连接；事务外的 SELECT 走读连接；事务外的写语句排在写锁后面。
2. **插件查询**（S5 网关）：
    - 读查询走专用的 worker 连接（架构 E）。这个连接以只读方式打开，authorizer 只放行 `p_<插件 id>__` 前缀的表。authorizer 在编译语句时检查，而物理表名就在 SQL 里，所以多个插件可以共用一个 worker：每次执行前设好当前插件，语句缓存按 SQL 文本区分即可。
    - 网关给每条查询加上期限函数，查询卡住时换掉 worker。
    - 写查询仍走核心的写连接，同样加期限函数。
3. **插件自己开的事务**：SQLite 模式下默认时限 100 ms，超时回滚。插件文档要写明"事务里不要发网络请求"。拦截器加入核心事务的方式不受这条限制，因为事务的长短由核心控制。
4. **其他进程写库**：命令行里的写操作要么经由运行中的服务完成，要么在服务停止时执行。主线程写连接的 busy_timeout 设得短一些（例如 100 ms），以免被外部写锁卡住太久。
5. **读连接放进 worker（架构 C）可以作为大站的调优选项**：饱和时吞吐高约 40%，但串行延迟多约 70 µs。默认不开。
6. **写连接不放进 worker（不用架构 D）**：写事务延迟翻倍，复杂度也更高。核心自己的查询有索引、有测试，可控。

## 遗留风险

- **worker 入口文件在 Next.js 构建后能否找到**：需要把 `packages/db` 设为 `serverExternalPackages`，或者由启动器负责加载，在搭脚手架时验证。
- **Node 26 / SQLite 3.54 的重复编译问题**：SQLite 已修复（check-in 535a77cf5a），还要等两件事：SQLite 发布包含修复的版本（预计是 3.54.2），Node 26 升级内置的 SQLite。在那之前，Node 26 上的 JOIN 查询每次多约 7 µs。
- **插件事务 100 ms 的时限是否够用**：要用真实插件（例如邀请码、积分类插件）检验。
- **压测机器是共享的**：数据只适合比较不同架构之间的差异，不能当作容量规划的依据。
