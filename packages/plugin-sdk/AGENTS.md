# packages/plugin-sdk

插件 API 的类型与少量运行时辅助函数。这里的每一个导出都是对社区的承诺，改动成本远高于核心内部代码。设计依据见 `docs/adr/0010-plugin-api.md`。

## 当前状态

正在照 `docs/adr/0035-plugin-sdk-release.md` 准备发布 1.0：先发 `1.0.0-rc.N`，候选期里公开面还能改，1.0.0 之后冻住。公开面是 `docs/adr/0033-plugin-system-v1.md` 的第一版加上 ADR-0035 冻结前的调整；新增扩展点、能力要先改 ADR。

和构建命令 `@nextskin/plugin-cli` 在 changesets 的 `fixed` 组里，版本号相同。插件 API 的版本就是本包的版本号：核心的 `PLUGIN_API_VERSION` 从这里的 package.json 读，manifest 的 `api` 取到次版本（ADR-0035）。

- 仓库里 `exports` 指向 `src`；发布时 `publishConfig` 换成 `build` 生成的 `dist`（JS 和声明文件）。包里还有 `docs/`（作者文档）、README 和 LICENSE。
- zod、kysely 的依赖锁着和 catalog 相同的次版本：插件运行时用的是核心的那一份（`packages/plugin-cli/src/release.test.ts` 守着）。

`pnpm check` 覆盖本包：

- `typecheck`：TS 7 检查 `src`、`type-tests`；
- `test`：用 TS 7 生成 `dist`（`build`），再让 api-extractor 和 `etc/plugin-sdk.api.md` 比对，公开面有任何变化都会失败。

打成 npm 包之后能不能用，由 `pnpm test:pack` 检查（要联网，CI 跑）。

公开面确实要变时：运行 `pnpm --filter @nextskin/plugin-sdk api:update` 更新报告，再运行 `pnpm changeset` 写变更记录，两者一起提交。

CI 用 `changeset status` 检查：本包 `src` 有任何改动都要附 changeset（`.changeset/config.json` 的 `changedFilePatterns`）。不影响公开面的改动（注释、内部实现）用 `pnpm changeset --empty`。

## 改这个包之前

- **公开 API 是契约。** 新增事件、拦截点、能力、字段是次版本变更。删除或改名、收窄参数类型、放宽返回类型都是大版本变更。任何公开面变化都必须附 changeset。
- **一切都要能跨进程。** 插件可能运行在另一个进程里。所有插件提供的函数都返回 Promise。所有 DTO 都必须可结构化克隆、可无损转成 JSON：不放 Date（用 ISO 字符串），不放类实例和函数。
- **只暴露 DTO，不暴露表结构。** `dto.ts` 里的类型和数据库列一一对应只是巧合，不能当成约定。
- **能在类型层面拒绝的错误，就不要留到运行时。** 能力不足、权限名拼错、拦截器改字段、事务内的拦截器发网络请求、插件开事务、路由键格式错误，现在都会编译失败，见 `type-tests/contracts.ts`。新增约束时同步加一条 `@ts-expect-error` 用例。一个 `definePlugin` 调用里只放一个结构性错误，原因见该文件头部注释。
- **类型约束不等于安全。** 插件可以是手写 JS，所以核心在运行时必须重复每一条检查：能力、表名白名单、拦截器的返回值、事务内拦截器能用的 RPC、出站 origin。
- **manifest 是核心唯一认的东西。** 核心登记路由、事件、拦截器、Provider、任务所需的每一项（任务的重试次数和超时、路由的请求体上限……）都要出现在 `PluginManifest` 里，`definePlugin` 新加的字段要同步加进 manifest 和核心的提取函数。
- **运行时导出由 host 提供。** `nextskin-plugin build` 不把本包和 `zod` 打进插件包，plugin host 用自己带的那份（`packages/plugin-host/src/package/module-loader.ts` 的 `PLUGIN_EXTERNALS`），`instanceof` 和 zod 的全局注册表（`secret()`）才和核心一致；插件的其他裸导入一律拒绝。本包新增运行时依赖时，要么打进本包自己，要么加进 `PLUGIN_EXTERNALS`。
- **`src` 里的相对导入写 `.ts` 扩展名。** set-role、导入器的命令行这些 Node 直接运行的脚本经 domain → plugin-host 加载本包的源码，Node 的类型剥离不补扩展名，类型检查却不报错。
- **新增拦截点要谨慎。** 每个拦截点都必须在 `interceptorPolicies` 里写明失败策略、超时和是否在事务内。不加"拦截任意数据"的通用 filter，这是 ADR-0010 明确否决的。

## 插件自有表的硬性规则（S5 验证得出，核心会在运行时强制执行）

- 插件 id：`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`。表名、索引名、约束名：`^[a-z][a-z0-9]*(_[a-z0-9]+)*$`。物理名 `p_<id，连字符换成下划线>__<名字>` 不超过 63 字符。不要放宽这两个正则：它们保证不同插件的物理名不可能相同。
- 一个 FROM 项加最多 4 个 inner/left JOIN；没有 INSERT…SELECT、CTE、窗口函数；RETURNING 只能用在 INSERT 上。
- 运算符、函数、聚合、数据类型都有白名单（见 `spikes/s5-remote-kysely/src/sanitize.ts`）。SDK 文档里列出的能力必须与这些白名单一致。
- 第一版插件不能自己开事务（ADR-0033）：每条语句单独提交，需要原子性就用一条带条件的语句。只有事务内的拦截器加入核心事务，那里的 `ctx` 只有 `db` 和不用等核心回应的几项，没有 `fetch`、`kv`、`jobs`。插件的读查询在专用 worker 连接上执行，带期限，超时被中止（S2）。

## 写插件表迁移时的坑（同样要写进面向插件作者的文档）

- 自增主键在三种数据库里写法不同（`autoIncrement()` 在 PostgreSQL 上不可用）。优先使用自然键或字符串键。
- MySQL 的主键和索引列不能是 `text`，用 `varchar(n)`。
- 日期列一律存 ISO 字符串：SQLite 没有原生日期类型，三种数据库的时区行为也不一致。查询参数传 `Date` 会被核心拒绝：node:sqlite 会把排在第一位的对象参数当成命名参数表，后面的参数整体错位，不报错（见 `spikes/s2-node-sqlite/README.md`）。
- `count()` 返回值在不同数据库里可能是 number、string 或 bigint，一律套 `Number()`。
- MySQL 不支持 `returning`。需要新行的 id 时，用 `insertId` 或改用自然键。
