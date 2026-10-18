# packages/importer

从 BS v6 导入（ADR-0031）。导入引擎由命令行（`src/cli.ts`，根目录的 `pnpm import:bs`）和网页导入服务（`src/service.ts`，安装向导和后台的"数据迁移"）共用；逐表的规则在 `docs/schema.md` 的"从 BS 导入"，写代码前先读。服主看的迁移步骤在 `MIGRATION.md`。

## 不变量 4 的例外只在这里

- 导入器直接写表，不经过领域用例：导入的是历史状态，不该触发事件、审计和按现价收费。别的包不要学这种写法。
- 编码规则（密码格式、名字规范化、UUID 算法、设置编码、像素 hash、材质存储）一律从 `@nextskin/domain/importer` 取，不要自己再实现一份：写进库里的值必须和用例写的一致。
- 积分只写一条"导入"流水（`score.reasons.import`），余额等于导入的积分；改了 `users.score` 的地方（例如举报退还）要在写流水之前。

## 一次运行

- 旧库在一个只读快照里单遍读（`@nextskin/db` 的 `readSnapshot`），目标库在一个事务里先清空、再写入。停止类问题先收集、读完再判断，有任何一条、试跑、取消或出错就整体回滚。不要在旧库上开第二条连接：两条连接看到的不是同一个快照。
- 内存里只留查冲突要用的键（邮箱、角色名、UUID）。引用是否还在，按批去目标库（同一个事务）里查，不要把整张表读进内存。
- 材质文件在事务之外复制，回滚后多出来的由 `core:texture-sweep` 回收。这次运行写的 `texture_files` 行带着运行标识（`claim_id`），提交前清掉；没用到的旧行删掉。
- 旧库的列在三种数据库上的 JS 类型不同（SQLite 的整数读成 bigint，超过 2^53 的 bigint 在 MySQL、PostgreSQL 上是字符串），读出来都经过 `src/values.ts` 转换；时间是旧站时区的本地时间。
- 回滚不会撤销的副作用要单独处理：MySQL 的自增计数器回滚之后恢复，PostgreSQL 的 `setval` 只在确定提交时调用，存储里多出来的文件交给回收任务。
- "导入之后新站产生的数据"按提交时记下的 `watermark` 判断，不按导入的行自带的时间（旧站的时间可能在未来）。新加会被清空的表时，同时更新 `target.ts` 的 `BUSINESS_TABLES` 和新站数据的判断。
- 新的停止类问题：在 `report.ts` 的 `BlockingIssue` 加一种，`markdown.ts` 的 `describeIssue` 写清楚在旧站怎么处理。

## 网页导入服务（`src/service.ts`）

- `apps/web` 在创建核心时一并创建它、注入 Hono 应用；`packages/api` 只依赖它自己的 `src/import-gateway.ts` 里声明的接口类型，不依赖这个包。
- 它另开一个 Kysely 实例，不和核心共用连接：SQLite 上导入的长事务一直占着写锁，核心的读要能继续（维护页、进度）。
- 同时只有一个运行。从 `start` 到收尾完成是维护模式：Hono 返回 503，proxy 把页面换成维护页，任务执行器和调度器暂停（`maintenance.enter/exit` 由 `apps/web` 提供）。最终状态在退出维护之后才对外可见：网页看到结束就会跳走。
- 进度只在内存里，运行令牌只存摘要；数据库密码和盐只在这次运行的闭包里。服务启动时把上次中途退出的运行标为失败。
- 维护期间不要在页面或接口里读写会被导入锁住的东西：会话（Better Auth 可能顺手续期）、要写库的用例。

## 测试

- `*.db.test.ts` 在四种数据库上各跑一遍，源库和目标库各用一个测试库；源库按 BS 6.0.2 的迁移建表（`src/testing/bs.ts`）。比较规则由旧库决定的地方（按名字关联 UUID）是有意的方言差异，用例里写明原因。
- 录制环境上的端到端检查：`pnpm --filter @nextskin/contract-tests import-replay`（需要 Docker，见 `tests/contract/README.md`）。改了导入规则后手动跑一次。
- 网页的 e2e（`apps/web/e2e/setup.spec.ts`）用 `scripts/bs-sqlite-site.ts` 生成一个按 BS 表结构建的 SQLite 旧站，不需要 Docker；里面故意留了一处 UUID 冲突。手动检查安装向导时也可以用它：`node packages/importer/scripts/bs-sqlite-site.ts <目录>`，再把生成的 `.env` 粘进向导。
