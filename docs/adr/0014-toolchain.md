# ADR-0014 工具链：pnpm + Turborepo，TypeScript 7 做类型检查，ESLint、Prettier、Vitest、changesets

- 状态：已采纳
- 日期：2026-10-16

## 背景

ADR-0013 定了 Node、Next.js 和 TypeScript 的版本，AGENTS.md 约定了 `pnpm dev`、`pnpm check` 等命令的名字。但 monorepo 的任务编排、lint、格式化、测试和发版工具都还没定。

TypeScript 7 是 Go 实现，npm 包里只有命令行，没有 JS API：`require('typescript')` 只导出版本号。依赖编译器 API 的工具因此跑不起来：

- typescript-eslint 8.71 只支持 TypeScript 6.1 以下的版本；
- Next 的构建期类型检查、Storybook 从组件的 props 类型生成文档，也都调用这套 API。

TypeScript 6.0 是为过渡到 7 发布的最后一个 JS 实现版本，API 完整。

## 决定

### 包管理与任务编排

- 用 pnpm workspace。根 `package.json` 用 `packageManager` 锁定 pnpm 版本，`engines.node` 为 `>= 24`（ADR-0013）。
- 包之间的依赖只通过各包 `package.json` 里声明的 `workspace:*` 建立。pnpm 的严格 `node_modules` 让没声明的包导入不了，这是包边界的第一道防线。例如 `apps/web` 和 `packages/api` 都不声明 `@nextskin/db`，就写不出直接查库的代码（不变量 4）。
- 用 Turborepo 编排任务：`build`、`typecheck`、`lint`、`test`、`test:db`、`test:contract`、`e2e`、`dev`、`storybook`。根目录的 `pnpm <命令>` 都转给 `turbo run`，`pnpm check` 就是 `turbo run lint typecheck test`。
  - 只用本地缓存，不配远程缓存。
  - `test:db` 和 `e2e` 依赖外部数据库或浏览器，`dev` 和 `storybook` 是常驻进程，这四个任务都不缓存。

### TypeScript

- **类型检查用 TypeScript 7。** 每个包的 `typecheck` 任务运行 TS 7 的 `tsc --noEmit`。
- **TypeScript 6.0 只给依赖编译器 API 的工具用。** 根目录的 `typescript` 装 6.0，`require('typescript')` 解析到它；TS 7 用别名安装（`"typescript-native": "npm:typescript@7"`），脚本里按路径调用。
  - 两个包都提供 `tsc` 命令，`node_modules/.bin/tsc` 指向哪一个不可依赖（实测 pnpm 12 把它链到了 7），所以脚本里不写裸的 `tsc`。
  - 2026-10-16 在 pnpm 12.8 下实测：typescript-eslint 的类型感知规则能拿到 TS 6 的 API，按路径调用的 TS 7 类型检查正常。
- Next 关闭构建期类型检查（`typescript.ignoreBuildErrors: true`），由 `typecheck` 任务负责，免得再用 TS 6 检查一遍。
- 共享 tsconfig 在 ADR-0013 的 `strict`、`noUncheckedIndexedAccess` 之外，再开 `verbatimModuleSyntax`、`isolatedModules`、`erasableSyntaxOnly`。`erasableSyntaxOnly` 禁止 enum、namespace、参数属性这类需要编译的语法，保证脚本和工具代码能直接用 Node 的类型剥离运行（`node x.ts`），不需要 tsx。
- 编辑器默认使用工作区里 TS 6 的语言服务。两者结果不一致时，以 CI 上 TS 7 的检查为准。

### Lint 与格式化

- ESLint 10（flat config），加上 typescript-eslint 的类型感知规则（`recommendedTypeChecked`，使用 `projectService`）。
- 能写成规则的不变量都写成 lint 规则，规则落地后从 AGENTS.md 删掉对应的文字：
  - 禁止 `NEXT_PUBLIC_*`（不变量 7）；
  - 禁止导入 `next/image`（不变量 8）；
  - `packages/db` 以外禁止导入 Kysely 的 `SqliteDialect` 和 Better Auth 的 `NodeSqliteDialect`（AGENTS.md"已知的坑"）；
  - `packages/ui` 以外禁止原始色值、任意值类，以及内联样式里的颜色（不变量 10、ADR-0012）；
  - 禁止 `'use server'`（不变量 4、ADR-0003：不用 Server Actions）；
  - 页面里禁止渲染 `<link rel="modulepreload">`（ADR-0011）。

  自有规则放在 workspace 内的一个 ESLint 插件里，每条规则都配正反例测试。
- 格式交给 Prettier 3，ESLint 不管格式。配置与现有代码一致：不加分号、单引号、尾逗号、行宽 120。

### 测试

- 单元测试和集成测试用 Vitest。
  - 数据库测试（`test:db`）：同一套用例按方言跑 SQLite、MySQL、MariaDB、PostgreSQL，后三种由 Docker Compose 提供（不变量 6）。
  - 协议契约测试（`test:contract`）：直接调用 Hono 的 `app.request()`，用例录制自真实的 BS v6（ADR-0003）。
- 组件用 Storybook 10（`@storybook/react-vite`：组件库不依赖 Next）。story 通过 Storybook 的 Vitest 插件在浏览器里作为交互测试运行（ADR-0012）。
- 端到端测试和截图回归用 Playwright。Playwright 的版本锁定，浏览器版本随之固定。

### 版本与发布

- 插件 SDK 等对外发布的包，用 changesets 管理版本号和变更记录（不变量 9）。核心应用的版本不走 changesets。
- 插件 API 的公开面用 api-extractor 生成报告（ADR-0010）。api-extractor 自带 TypeScript 5.9，读取 TS 7 生成的 `.d.ts`。

## 后果

- 依赖编译器 API 的工具和类型检查用的不是同一个 TypeScript 版本，个别检查结果可能不同，以 TS 7 为准。typescript-eslint 等工具支持 TS 7 之后，去掉 TS 6，并另写 ADR 记录。
- 类型感知的 lint 规则比纯语法规则慢，lint 任务靠 Turborepo 的缓存按包增量运行。
- 搭脚手架时要验证：
  - api-extractor（自带 TS 5.9）能读 TS 7 生成的声明文件；
  - Storybook 的文档生成在 TS 6 下正常；
  - Turborepo 的缓存不会让依赖外部服务的测试被跳过（这些任务已经设为不缓存）；
  - ADR-0008 遗留的问题：worker 入口文件在 `next build` 之后还能找到；
  - S3 记录的问题：`next dev` 会在项目目录生成 `AGENTS.md`、改写 `tsconfig.json`，要配 `agentRules: false`。

## 考虑过的其他方案

- **只用 pnpm 的递归脚本，不用 Turborepo**：少一个工具，但没有任务缓存，也不按依赖图排序，包多了以后 `pnpm check` 会越来越慢。
- **用 Biome 或 oxlint 代替 ESLint**：快得多，但类型感知规则和自定义规则的生态都不如 ESLint。不变量要靠自定义规则守护，这一点优先。
- **根目录的 `typescript` 装 7，再给 typescript-eslint 单独补一份 6**：`require('typescript')` 默认拿到没有 API 的 7，每个依赖 API 的工具都要单独配置（pnpm 的 `packageExtensions`），比反过来麻烦。
- **只用 TypeScript 6**：放弃 TS 7 的类型检查速度，与 ADR-0013 冲突。
