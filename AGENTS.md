# NextSkin

用 TypeScript 全栈重写 Blessing Skin Server（以下简称 BS）。BS 是一个 Minecraft 皮肤托管与外置登录（Yggdrasil）站点，主要由服主自行部署。

## 当前阶段

monorepo 骨架、工具链、CI（`.github/workflows/ci.yml`）和 Renovate 已经搭好（ADR-0013、ADR-0014）。已经落地：核心表的第一批迁移；只读协议端点（CSL、USM、Legacy、`/textures`、Yggdrasil 的元数据和角色查询）及其契约测试。认证切片进行中：Better Auth 的表和配置、旧密码兼容、serial 下的能力限制、注册用例和注册规则、邮件发送、注册接口（`POST /api/register`，第一个 REST 接口，`packages/api/src/rest/`）、登录注册和找回密码的页面已经落地（ADR-0018），Yggdrasil Connect 还没有。国际化已接入（ADR-0019）。后台任务和积分流水已经落地（ADR-0021）：任务表和执行器、事件在业务事务里按订阅者展开成任务、邮件改为持久的任务、`adjustScore`。用户中心已经落地（ADR-0022）：外壳和导航、仪表盘（积分、签到）、角色管理，写接口认会话 Cookie。个人资料和账号安全已经落地（ADR-0023、ADR-0024）：改昵称和语言、改邮箱、删除账号、两步验证、通行密钥；核对密码的 REST 接口按用户限流。材质上传和皮肤库已经落地（ADR-0025）：纯 JS 的 PNG 解码、图像 worker 池、出图端点 `/render/…`、上传和上传者的管理、皮肤库和详情页（3D 预览）、用延迟任务推进的文件回收。衣柜、换材质和举报已经落地（ADR-0026）：衣柜页和 `GET /api/closet`、给角色换材质、头像、提交举报和“我的举报”。后台已经落地（ADR-0027）：固定角色映射到具名权限（`can()`）、审计日志、处理举报、管理员删除材质、封禁和任免管理员；用户管理的其余操作还没有。设置页已经落地（ADR-0028）：表单由设置注册表生成，只有超级管理员能改；公告和内容政策（Markdown，不渲染原始 HTML）、生成签名密钥、测试邮件。定时任务已经落地（ADR-0029）：`job_schedules` 和调度器（cron 按站点时区解释，用 croner），清理过期的认证数据、按保留期清理审计日志、回收材质存储里的孤儿文件和临时文件。

- 已做的决定都在 `docs/adr/`，从 `docs/adr/README.md` 的索引和 spike 列表看起。
- 早期的两份研究报告已经删除。它们推荐过、但已被 ADR 否决的方案不要再引入：同进程 `import()` 热重载插件、Drizzle 多套 schema、PHP sidecar、把 Redis 设为必需。否决理由见对应 ADR。
- 核心表的设计在 `docs/schema.md`，跨表约定（时间、布尔、JSON、外键、UUID）见 ADR-0015。写迁移前先读。
- 视觉与界面规范在 `DESIGN.md`。
- 插件 API 草案在 `packages/plugin-sdk/`，该目录有自己的 AGENTS.md。
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
| `pnpm dev` | 启动开发环境，不依赖任何外部服务（默认 SQLite，数据在 `apps/web/data`；环境变量见 `packages/domain/src/bootstrap.ts`。种子数据还没有） |
| `pnpm check` | lint + 类型检查 + 单元测试 + 格式检查；提交前必须通过。CI 还会跑 `test:db` 和 `e2e`，改了数据库代码或 Next 配置时先在本地跑 |
| `pnpm build` | 构建 Next standalone 产物和插件 SDK 的声明文件。Next 关了构建期类型检查，所以会先对构建涉及的每个包跑 `typecheck` |
| `pnpm test <path>` | 只跑指定文件或目录的测试 |
| `pnpm test:db` | 在 SQLite / MySQL / MariaDB / PostgreSQL 四种数据库上跑 `*.db.test.ts`（需要 Docker，测试库容器跑完后保留；`pnpm test` 只用 SQLite 跑） |
| `pnpm test:contract` | 协议契约测试：回放从真实 BS v6 录制的用例，不需要 Docker，`pnpm check` 也会跑。录制见 `tests/contract/README.md` |
| `pnpm storybook` | 组件工作台 |
| `pnpm design:sync` | 改了 `packages/ui/src/theme.css` 之后，重新生成 DESIGN.md §3 的 token 表（不同步时 ui 的测试会失败） |
| `pnpm font:sync` | 重新生成像素字体的分片（DESIGN.md §4），需要联网；只在换字体版本或改切片规则时运行 |
| `pnpm e2e` | Playwright 端到端测试；也经过 Next standalone 回放全部契约用例 |
| `pnpm test:visual` | 组件截图回归：给每个 story 拍亮暗两张截图，和基线比较（需要 Docker，浏览器跑在容器里）。外观改动是有意的，就加 `-- --update-snapshots` 更新基线，并检查新截图 |
| `pnpm format` | Prettier 格式化 |
| `pnpm set-role <邮箱> <角色>` | 设定用户的角色，例如开发库里的第一个超级管理员（ADR-0027）；读和 `pnpm dev` 相同的环境变量 |

单元测试和 story 测试跑在 Chromium 里，第一次运行前要装浏览器：`pnpm --filter @nextskin/web exec playwright install chromium`。

## 不变量

每一条都写明"为什么"以及"由什么守护"；由 lint 守护的条目，原因写在规则的报错里。破坏任何一条都等于引入线上事故。

1. **Minecraft 协议（CSL / USM / Legacy / Yggdrasil）的路径、状态码、响应结构、响应头与 BS v6 一致。** 玩家的模组和启动器无法跟着升级。守护：`tests/contract`。
2. **玩家 UUID 创建后永不改变，导入旧数据时原样保留。** 游戏服务器按 UUID 存储玩家的背包和权限，UUID 一变，这些数据全部对不上。守护：导入器测试、对账报告。
3. **已存在的材质文件永不重新编码。新材质的 hash 是像素 hash：sha256(u32be(宽) ‖ u32be(高) ‖ RGBA8 像素)，不是文件字节的 hash。** hash 既是存储键，也是公开 URL 的一部分；文件字节的 hash 会随 zlib 版本和 CPU 架构变化（ADR-0008）。
4. **写操作只能经过领域用例。** Route handler 里不写 SQL，也不写业务规则；不用 Server Actions 写数据。见 ADR-0004。守护：包依赖（`apps/web`、`packages/api` 不依赖 `@nextskin/db`）、lint `nextskin/no-use-server`。
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
| `packages/plugin-sdk`、`plugin-host`、`plugin-testing` | 插件 API、插件运行时、插件测试工具 |
| `packages/eslint-plugin` | 把不变量写成的 lint 规则 |
| `packages/importer` | 从 BS v6 只读导入 |
| `plugins/*` | 官方插件，用公开 API 编写 |
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
- Node 直接运行的代码（脚本、ESLint 插件，以及将来的启动器和 plugin host）里，相对导入要写 `.ts` 扩展名：Node 的类型剥离不补扩展名，类型检查却不会报错。
- pnpm 12 拒绝安装发布不到 1 天的版本（`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`）。换一个早一点的版本，不要往 `pnpm-workspace.yaml` 里加 `minimumReleaseAgeExclude`。
- 术语：**材质**是皮肤和披风的统称；**角色**（player）是 Minecraft 里的玩家名，不是**用户**（user）。一个用户可以有多个角色。

## 维护这份文件

- 只写从代码里推断不出来的东西。agent 重复犯同一个错时才加一条；能改成 lint 或测试的规则，加上检查后就删掉文字。
- 控制在 150 行以内。包内的局部规则写在各包自己的 AGENTS.md。
