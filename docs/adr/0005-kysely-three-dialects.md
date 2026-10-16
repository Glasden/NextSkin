# ADR-0005 数据访问用 Kysely，支持 SQLite / MySQL / PostgreSQL

- 状态：已采纳
- 日期：2026-10-16

## 背景

小站希望零配置（SQLite），宝塔用户手上是 MySQL/MariaDB，大站可能用 PostgreSQL。目标是一份代码在运行时根据配置连接任意一种。

- **Drizzle**：按设计为每种方言定义互不兼容的表类型，需要维护三套 schema、三套迁移，仓储层还要对三种数据库类型分别泛型化。
- **Prisma**：查询 API 与方言无关，但 provider 写在 schema 里，需要生成三份客户端、维护三套迁移历史，而且它的迁移命令行正处于换代期。

## 决定

- 使用 **Kysely**：查询构建器与方言无关，同一份查询代码可以跑在三种数据库上。
- 迁移用 Kysely 的 schema builder 编写，三种方言共享。确实需要按方言分支时，只允许写在迁移辅助函数里。
- 方言差异集中封装在 `packages/db` 的辅助函数里，业务代码不得直接使用：
  - `returning`（MySQL 不支持）；
  - upsert（`onConflict` 与 `onDuplicateKeyUpdate`）；
  - 自增主键；
  - `count` 返回值的类型。
- CI 用 testcontainers 跑 MySQL 8、MariaDB、PostgreSQL，加上 SQLite，组成测试矩阵。凡是涉及数据库的测试都要在这四种环境下跑一遍。
- 不再支持 SQL Server。

## 后果

- 业务代码只写一份。代价是方言相关的功能（例如 PostgreSQL 的 JSONB、数组类型）只能在辅助函数里有条件地使用，或者干脆不用。
- Better Auth（ADR-0007）内部同样基于 Kysely，可以共用连接。
- 插件的自有表也用 Kysely 声明，同一套机制让插件自动支持三种数据库（ADR-0010）。

## 考虑过的其他方案

见背景部分。研判报告推荐 Drizzle，但它自己也承认 Drizzle 不支持跨方言，结论前后矛盾。
