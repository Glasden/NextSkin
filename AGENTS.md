# NextSkin

用 TypeScript 全栈重写 Blessing Skin Server（以下简称 BS）。BS 是一个 Minecraft 皮肤托管与外置登录（Yggdrasil）站点，主要由服主自行部署。

## 当前阶段

插件系统第一版（ADR-0033）的三步都已落地，插件 SDK 1.0 进入候选期（ADR-0035，`1.0.0-rc.N`）；后台其余管理操作（ADR-0036）正在按三个切片实现，切片一（用户详情页和账号操作）已经落地。各领域已经落地和还没做的部分逐项列在 `PROGRESS.md`；判断某个功能有没有、做到哪一步，先看它。

- 已做的决定都在 `docs/adr/`，从 `docs/adr/README.md` 的索引和 spike 列表看起。
- 早期的两份研究报告已经删除。它们推荐过、但已被 ADR 否决的方案不要再引入：同进程 `import()` 热重载插件、Drizzle 多套 schema、PHP sidecar、把 Redis 设为必需。否决理由见对应 ADR。
- 核心表的设计在 `docs/schema.md`，跨表约定（时间、布尔、JSON、外键、UUID）见 ADR-0015。写迁移前先读。
- 视觉与界面规范在 `DESIGN.md`。
- 插件 API 在 `packages/plugin-sdk/`（和构建命令一起发布到 npm，ADR-0035），该目录有自己的 AGENTS.md。
- `spikes/` 是技术验证代码，结论写在各自的 README 和对应 ADR 里。这些代码不按产品标准维护，移植进正式代码时要重新审视。

## 系统结构

```
nextskin 启动器（进程监管 + 命令行）
 ├─ 核心进程：Next.js（只做页面）+ Hono（协议端点 / REST / 插件路由）+ 领域层
 │            └─ Kysely → SQLite（默认）| MySQL/MariaDB | PostgreSQL
 └─ plugin host 进程：运行安装插件，通过 RPC 调用核心，没有数据库凭据
```

## 命令

| 命令 | 用途 |
|---|---|
| `pnpm dev` | 启动开发环境，不依赖任何外部服务（默认 SQLite，数据在 `apps/web/data`；环境变量见 `packages/domain/src/bootstrap.ts`。种子数据还没有：空库先在 `/setup` 建站，安装码在数据目录的 `setup-code`，安装之前不能注册） |
| `pnpm check` | lint + 类型检查 + 单元测试 + 格式检查；提交前必须通过。CI 还会跑 `test:db` 和 `e2e`，改了数据库代码或 Next 配置时先在本地跑 |
| `pnpm build` | 构建 Next standalone 产物、插件 SDK 的声明文件和 plugin host 的单文件包（`packages/plugin-host/dist/host.mjs`，standalone 里运行它）。Next 关了构建期类型检查，所以会先对构建涉及的每个包跑 `typecheck` |
| `pnpm test <path>` | 只跑指定文件或目录的测试 |
| `pnpm test:db` | 在 SQLite / MySQL / MariaDB / PostgreSQL 四种数据库上跑 `*.db.test.ts`（需要 Docker，测试库容器跑完后保留；`pnpm test` 只用 SQLite 跑） |
| `pnpm test:contract` | 协议契约测试：回放从真实 BS v6 录制的用例，不需要 Docker，`pnpm check` 也会跑。录制见 `tests/contract/README.md` |
| `pnpm storybook` | 组件工作台 |
| `pnpm design:sync` | 改了 `packages/ui/src/theme.css` 或标志的图形之后，重新生成 DESIGN.md §3 的 token 表和 `apps/web/app` 里的站点图标（不同步时 ui 的测试会失败） |
| `pnpm font:sync` | 重新生成像素字体的分片（DESIGN.md §4），需要联网；只在换字体版本或改切片规则时运行 |
| `pnpm e2e` | Playwright 端到端测试；也经过 Next standalone 回放全部契约用例 |
| `pnpm test:visual` | 组件截图回归：给每个 story 拍亮暗两张截图，和基线比较（需要 Docker，浏览器跑在容器里）。外观改动是有意的，就加 `-- --update-snapshots` 更新基线，并检查新截图 |
| `pnpm test:pack` | 打包冒烟测试：在仓库外用 npm 安装 `pnpm pack` 出来的 SDK 和构建命令，类型检查、构建一个插件（要联网，不进 `pnpm check`，ADR-0035） |
| `pnpm release` | 发布插件 SDK 和构建命令：先跑 `test:pack`，再 `changeset publish`。平时由 `.github/workflows/release.yml` 运行，版本号先在本地用 `pnpm changeset version` 改好（ADR-0035） |
| `pnpm format` | Prettier 格式化 |
| `pnpm import:bs -- <参数>` | 从 BS v6 导入（ADR-0031），参数见 `-- --help`，步骤见 `packages/importer/MIGRATION.md`；读和 `pnpm dev` 相同的环境变量，运行时服务要停着 |
| `pnpm set-role <邮箱> <身份>` | 设定用户的身份（`users.role`），例如另指定一个超级管理员（ADR-0027）；第一个超级管理员在安装向导 `/setup` 里创建，安装码在数据目录的 `setup-code` 文件（ADR-0031）。读和 `pnpm dev` 相同的环境变量 |
| `pnpm set-password <邮箱或 uid> [--remove-other-methods] [--email <新地址>]` | 给用户设新密码，超级管理员丢了密码或账号失控时用（后台动不了超级管理员，ADR-0036）。密码在终端里输入两次、不回显；退出对方全部登录，`--remove-other-methods` 删掉全部通行密钥、解绑全部第三方账号，`--email` 把邮箱立即换成新地址。读和 `pnpm dev` 相同的环境变量 |
| `pnpm disable-2fa <邮箱或 uid>` | 关掉用户的两步验证，超级管理员丢了验证器和备用码时用（ADR-0036）；不退出登录。读和 `pnpm dev` 相同的环境变量 |

单元测试和 story 测试跑在 Chromium 里，第一次运行前要装浏览器：`pnpm --filter @nextskin/web exec playwright install chromium`。

## 不变量

每一条都写明"为什么"以及"由什么守护"；由 lint 守护的条目，原因写在规则的报错里。破坏任何一条都等于引入线上事故。

1. **Minecraft 协议（CSL / USM / Legacy / Yggdrasil）的路径、状态码、响应结构、响应头与 BS v6 一致。** 玩家的模组和启动器无法跟着升级。守护：`tests/contract`。
2. **玩家 UUID 创建后永不改变，导入旧数据时原样保留。** 游戏服务器按 UUID 存储玩家的背包和权限，UUID 一变，这些数据全部对不上。守护：导入器测试、对账报告。
3. **已存在的材质文件永不重新编码。新材质的 hash 是像素 hash：sha256(u32be(宽) ‖ u32be(高) ‖ RGBA8 像素)，不是文件字节的 hash。** hash 既是存储键，也是公开 URL 的一部分；文件字节的 hash 会随 zlib 版本和 CPU 架构变化（ADR-0008）。
4. **写操作只能经过领域用例。** Route handler 里不写 SQL，也不写业务规则；不用 Server Actions 写数据。见 ADR-0004。唯一的例外是 `packages/importer`：导入的是历史状态，不该触发事件、审计和按现价收费，所以直接写表（ADR-0031）。守护：包依赖（`apps/web`、`packages/api` 不依赖 `@nextskin/db`）、lint `nextskin/no-use-server`。
5. **积分、点赞数这类计数，在事务内原子更新。** 禁止"先读、再算、再写回"。
6. **数据库代码必须在四种数据库上都通过。** `returning`、upsert、自增主键、`count` 只能通过 `packages/db` 的辅助函数使用。见 ADR-0005。守护：`pnpm test:db`、lint。
7. **不使用 `NEXT_PUBLIC_*`，站点配置存在数据库里。** 守护：lint。
8. **材质和任何用户上传的图片都不经过 `next/image`，Image Optimization 保持关闭。** 守护：lint、`next.config.ts`。
9. **插件 SDK 的公开 API 一旦变化，必须附 changeset，并通过 `packages/plugin-sdk/type-tests`。** 它是对社区的契约。守护：api-extractor 报告、CI 的 `changeset status`（见该包的 AGENTS.md）。
10. **UI 中不写原始色值和任意值类。** 需要组件时先在 `packages/ui` 里找；没有就先补组件和 story，再写页面。见 DESIGN.md。守护：lint、`theme.css` 清空了 Tailwind 的默认调色板。
11. **日志里不得出现密码、令牌、Cookie、OAuth secret、数据库连接串。**

## 目录（落地后的约定）

| 路径 | 内容 |
|---|---|
| `apps/web` | Next.js 页面，只做 UI |
| `packages/api` | Hono 应用：协议端点、REST API、插件路由网关 |
| `packages/domain` | 领域用例与查询服务，按业务领域分目录（users、players、textures、closet……） |
| `packages/db` | Kysely 实例、迁移、方言辅助函数 |
| `packages/ui` | 组件库与设计 token（`src/theme.css` 是 token 的唯一来源） |
| `packages/skin` | 材质的前处理和 2D 渲染，纯函数，服务端出图和浏览器上传页共用（ADR-0017） |
| `packages/i18n` | 界面文案（`messages/<语言>.json`）和语言解析，网页和领域层共用（ADR-0019） |
| `packages/email` | 邮件模板，无依赖的 HTML 模板函数（ADR-0020） |
| `packages/plugin-sdk`、`plugin-host` | 插件 API（公开面，ADR-0033）；插件侧的运行时：host 进程的入口和帧协议、加载插件定义、构造 `ctx`、插件包的格式和校验。核心侧的注册表、网关、换代和安装在 `packages/domain/src/plugins/` |
| `packages/plugin-cli` | `nextskin-plugin build`：把插件打成插件包（manifest、单文件的服务端代码、文案），插件作者和测试共用。和 SDK 一起发布到 npm，版本号相同；发布的是连同 plugin-host、SDK、zod 打成的单文件（ADR-0035） |
| `packages/eslint-plugin` | 把不变量写成的 lint 规则 |
| `packages/importer` | 从 BS v6 只读导入（ADR-0031）：导入引擎、命令行和网页导入服务（`apps/web` 创建、注入 Hono），迁移指南在 `MIGRATION.md`，该目录有自己的 AGENTS.md |
| `packages/oauth-client` | 几个 OAuth 官方插件共用的代码（拼授权地址、换令牌、读 ID 令牌），不发布，打进各插件的单文件；第三方插件不能依赖它（ADR-0034） |
| `plugins/*` | 官方插件，只用公开 API 编写，随站点发布、在后台启用；也是 ADR-0033 的参考插件 |
| `tests/contract` | 协议契约用例：从 BS v6 录制，回放比较（见该目录 README） |
| `docs/adr` | 架构决策记录 |
| `spikes/*` | 技术验证，见上文"当前阶段" |

## 常见任务的固定顺序

- **新功能**：领域用例（含事务、拦截器、事件）→ Hono 路由与 zod schema → UI。领域用例的错误只带 code 和参数；文案先写进 `packages/i18n` 的 `zh-CN.json`，同时写 `en.json`（ADR-0019）。
- **新数据表**：迁移 → 类型 → 仓储；跑 `pnpm test:db`。
- **新事件或拦截点**：先改 SDK 的类型、`interceptorPolicies` 和 type-tests，再在核心实现。这属于插件 API 变更。
- **新组件**：写进 `packages/ui`，照 `src/button/` 的样子配 story（同时是交互测试）和截图基线，并在 DESIGN.md 的组件清单里补一行。
- **新设置项**：在设置注册表（`packages/domain/src/settings/registry.ts`）里声明类型、默认值和分区（`section`），在 i18n 的 `admin.settings.fields` 下按键名写标签和说明（测试守着）。后台表单会自动生成，不要手写表单（ADR-0028）。
- **新的或改动的协议行为**：先在 `tests/contract/src/cases.ts` 加用例、从 BS v6 录制，再实现。
- **新包**：照抄现有包的 `package.json` 脚本和 `tsconfig.json`。包之间的依赖只用 `workspace:*` 声明；几个包共用的外部依赖，版本写进 `pnpm-workspace.yaml` 的 catalog。
- **刻意不跟上游升级的依赖**（TS 6、`@types/node` 24、测试库镜像这类）：在 `renovate.json` 里加一条写明原因的 packageRule，否则 Renovate 会提 PR 升级它。

## 已知的坑

- Next 16：`middleware.ts` 已改名为 `proxy.ts`；页面的 `params` 和 `searchParams` 是 Promise；同一个路由段不能同时有 `page.tsx` 和 `route.ts`。
- 根路径上的协议端点由 `next.config.ts` 的 rewrite 转进 `app/api/[...path]`，Route Handler 拿到的仍是改写前的 URL，所以 Hono 按公开路径注册路由。`request.url` 的 host 是 Next 自己的监听地址，需要客户端看到的站点地址时读 `Host` 头。
- 客户端 IP 不要直接读 `X-Forwarded-For`：Next 原样保留客户端自带的值。用 `packages/api` 的 `clientIp()`，它按设置 `network.trustedProxies` 和连接的对端地址解析（对端地址的来历见 `apps/web/lib/peer-address.ts`）。
- `pnpm dev` 里改了 `packages/api`、`packages/domain` 要重启：核心和 Hono 应用缓存在 `globalThis` 上（`apps/web/lib/server.ts`），热更新换不掉它们。
- Next 默认把末尾带斜杠的路径 308 跳转，已用 `skipTrailingSlashRedirect` 关掉：启动器会请求 `/api/yggdrasil/`，旧版 Java 不跟随 308。
- 协议端点里有些看起来像 bug 的 BS 行为（按名字查角色忽略末尾空格、批量查询返回请求里的名字……）是契约的一部分，改之前读 `tests/contract/README.md`。
- Next App Router 在浏览器里用的是它自带的 React（canary 版本），不是 `node_modules` 里的 `react`。插件组件要共享这份 React，只能通过 import map（ADR-0011）。
- Kysely 0.29：`Migration` 等迁移相关类型要从 `kysely/migration` 导入。
- SQLite 是同步执行的，写锁是全局的：事务里不要 `await` 网络请求或其他慢操作，否则所有写操作都要排队（ADR-0008）。
- Better Auth：`database.transaction` 默认是 `false`，必须打开；用户表主键列名只能叫 `id`。
- 服务端的 worker 写成 `new Worker(new URL('./x.ts', import.meta.url), …)`，Turbopack 会把它打成单独的 chunk，`next dev` 和 standalone 产物里都能运行。`workerData` 只能传普通对象：Turbopack 会把它展开、再塞进自己的字段，传数字、数组、TypedArray 会丢失或变形。不要用 `next build --webpack`，worker chunk 的路径会错。
- 脚本里不写裸的 `tsc`：`node_modules/.bin/tsc` 可能指向 TS 6 也可能指向 TS 7，类型检查按路径调用 TS 7（ADR-0014）。
- Node 直接运行的代码（脚本、ESLint 插件、开发和测试时的 plugin host，以及将来的启动器）里，相对导入要写 `.ts` 扩展名：Node 的类型剥离不补扩展名，类型检查却不会报错。
- pnpm 12 拒绝安装发布不到 1 天的版本（`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`）。换一个早一点的版本，不要往 `pnpm-workspace.yaml` 里加 `minimumReleaseAgeExclude`。
- 术语：**材质**是皮肤和披风的统称；**角色**（player）是 Minecraft 里的玩家名，不是**用户**（user）。一个用户可以有多个角色。**身份**指 `users.role`（封禁、用户、管理员、超级管理员），界面和文案里不叫角色。

## 维护这份文件

- 只写从代码里推断不出来的东西。agent 重复犯同一个错时才加一条；能改成 lint 或测试的规则，加上检查后就删掉文字。
- 控制在 150 行以内。包内的局部规则写在各包自己的 AGENTS.md。
- 进度不写在这里：切片落地时改 `PROGRESS.md`，"当前阶段"只改开头那一句。
