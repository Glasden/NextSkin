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

## 插件自有表

面向作者的规则、SQL 白名单和四种数据库的坑在 `docs/tables.md`，实现在 `packages/domain/src/plugins/db/`（`sanitize.ts`、`gateway.ts`）。文档列出的白名单由 `db/docs.test.ts` 和实现比对。

- 不要放宽插件 id（`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`）和表名（`^[a-z][a-z0-9]*(_[a-z0-9]+)*$`）的正则：它们保证不同插件的物理名 `p_<id>__<名字>` 不可能相同。
- 网关支持的查询范围和设置项能生成控件的形状是契约（ADR-0035 的两个例外），只放宽、不收紧。
