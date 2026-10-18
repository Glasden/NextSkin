# packages/db

Kysely 实例、SQLite 方言、迁移运行器，以及隔离四种数据库差异的辅助函数（ADR-0005、ADR-0008）。只有 `@nextskin/domain` 和导入器 `@nextskin/importer`（ADR-0031）依赖本包。`readSnapshot` 以只读的一致快照打开外部数据库（导入器读 BS 旧库），日期时间列读成库里存的字符串。

## 写查询和迁移

- 方言差异只能写在本包里。包外直接用 `returning`、`onConflict`、`autoIncrement`、`schema.createTable` 等会被 lint 拦下，报错会指向对应的辅助函数。缺少某个跨数据库的能力时，在这里补辅助函数，配上 `*.db.test.ts`。
- 建表一律用 `createTable(db, name)`，整数主键用 `.$call(autoIncrementId(db))`。MySQL 上的表统一使用 `utf8mb4_bin`，所以三种数据库的字符串相等比较都区分大小写：
  - 需要不区分大小写的字段（角色名、邮箱）要在 schema 里显式处理，例如另存一列规范化后的值，并在这列上建唯一索引；
  - `utf8mb4_bin` 比较时会忽略结尾空格，PG 和 SQLite 不会，所以输入要在领域层去掉首尾空格。CHECK 里的 `in (...)` 在 MySQL 上同样挡不住 `'active '`，枚举列的值只能来自代码里的常量；按唯一键查到行之后，要用 JS 再逐字比较一次键（见 `@nextskin/domain` 的角色、材质、设置查询）；
  - 有索引或唯一约束的字符串列要用 `varchar(n)`：MySQL 不能直接给 `text` 建索引，并且单个索引最长 3072 字节，即 `varchar(768)`。
- 列类型按 ADR-0015 和 `docs/schema.md` 的类型记号选辅助函数：
  - 时间用 `isoTimestampColumn`，值只能来自 `toIsoTimestamp`；
  - 0 / 1 开关用 `switchColumn`；
  - 可能超过 64 KB 的文本用 `longTextType`；
  - Better Auth 声明的日期、布尔字段用 `authDateType`、`authBooleanType`，直接读写这些列时用 `readAuthDate`、`writeAuthDate`、`readAuthBoolean` 转换；JSON / 数组列用 `authJsonType`，需要索引或限长的字符串列用 `authStringType`，兼容 Better Auth 的方言类型比对。
- 外键在建表时用表级的 `addForeignKeyConstraint`；给已有的表加外键列用 `addForeignKeyColumn`，只支持可空的整数列。不要用列定义里的 `.references()`：MySQL 会忽略它。
- MySQL 写入 `varchar` 时，超长部分如果是末尾空白（包括换行），会先被截掉再检查 CHECK。所以 ISO 时间列的 CHECK 拦不住"合法时间加换行"这种输入，格式由写入时只用 `toIsoTimestamp` 来保证。
- 核心迁移放在 `src/migrations/`。lint 在这个目录里重新生效：迁移里的方言差异同样只能通过辅助函数处理。
- MySQL 的 DDL 不在事务里，迁移中途失败会留下一半的改动，重跑时还会因为表已存在而失败。一个迁移只做一件事；迁移合入之后不再修改。
- SQLite 和 PG 的迁移在事务里执行。SQLite 重建表时，用 `pragma defer_foreign_keys = on`，不要用 `pragma foreign_keys = off`：后者在事务里不生效。
- 迁移按名字的字典序执行，名字用 `0001_xxx` 的格式。
- MySQL 的 UPDATE 按从左到右的顺序赋值，后面的赋值读到的是前面刚改过的值；PG 和 SQLite 读到的都是旧值。所以同一条 UPDATE（包括 `upsert` 的 `update` 表达式）里，不要读取同一条语句里也在赋值的列。
- `insertOrIgnore` 在 MySQL 上会把任何唯一键冲突都当成"已存在"，不只是传入的冲突列。冲突列以外还有唯一约束的表，要注意这一点。
- `upsert` 在 MySQL 上是逐行"先 update、再 insert"，不用 `on duplicate key update`：后者遇到冲突列以外的唯一键冲突时，会改掉另一行。为了四种数据库结果一致，`upsert` 有几条限制：`update` 不能改冲突列；多行时 `update` 只能是列名数组；列名数组里的列，每一行都必须给值。违反时执行前就会报错。另外，`values` 必须是一条能单独插入的合法行：MySQL 命中已有行时直接 update，不会像 PG、SQLite 那样先检查这一行的 CHECK 等约束。
- MySQL 的会话隔离级别统一设为 READ COMMITTED，与 PG 的默认值一致；SQLite 是串行化。业务代码不能依赖 REPEATABLE READ 的快照语义。
- 死锁（MySQL 1213、PG 40P01）和串行化失败（PG 40001）会让整个事务作废，只能由开启事务的一方重试整个事务。本包的辅助函数只在自己开的事务里重试。
- MySQL 的服务器错误大多只保留 errno、错误码和 SQLSTATE，原始消息被省略：消息里的值，甚至列名，都可能来自查询参数（不变量 11）。排查时在测试库上复现。往白名单里加 errno 之前，要在 MySQL 和 MariaDB 上实测（见 `connection-errors.mysql.db.test.ts`）。
- `dialectOf` 依赖 Kysely 标为 `@internal` 的 `getExecutor()`。升级 Kysely 后必须跑 `pnpm test:db`。
- 以后实现插件网关时，重新编译插件的建表语句也要加上 `createTable` 的 MySQL 表选项。插件拿到的是远程 Kysely（ADR-0010），用不了这里的辅助函数，lint 也不检查插件代码。

## 测试

- `*.db.test.ts` 会在四种数据库上各跑一遍。用 `@nextskin/db/testing` 的 `createTestDatabase()` 在 `beforeAll` 里拿到一个独立的空库（SQLite 是临时文件，其他三种是随机命名的库），在 `afterAll` 里调用 `cleanup()`。
- 测试进程跑在 `Asia/Shanghai` 时区（见两个 vitest 配置），故意让依赖本地时区的写法失败。
- 用例里不按方言分支断言。确实是有意的差异（例如上面 `insertOrIgnore` 的冲突范围）时，写明原因。
- `pnpm test` 只用 SQLite 跑这些用例，不需要 Docker；`pnpm test:db` 会先起 `compose.yaml` 里的 MySQL 8.4、MariaDB 10.11、PostgreSQL 15，再跑四种数据库。容器跑完后保留，方便重跑。停掉容器：`docker compose -f packages/db/compose.yaml down`。
- 只跑一种数据库：`pnpm --filter @nextskin/db exec vitest run --config vitest.db.config.ts --project db:mysql`。连接别的服务器时，用 `NEXTSKIN_TEST_{MYSQL,MARIADB,POSTGRES}_URL` 覆盖，账号要有建库和删库的权限。
