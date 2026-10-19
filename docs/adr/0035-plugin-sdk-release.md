# ADR-0035 插件 SDK 1.0 的发布：SDK 和构建命令一起发到 npm，版本号相同；插件 API 版本就是 SDK 的版本号，manifest 的 `api` 只取到次版本；作者文档随包发布；先发候选版

- 状态：提议
- 日期：2026-10-19
- 补充 ADR-0010 第 6 条（独立版本号）：插件 API 的版本怎么算，哪些变化算破坏性
- 补充 ADR-0014"版本与发布"：发布流程
- 补充 ADR-0033：构建命令和 SDK 一起公开发布；`packages/plugin-testing` 仍然推迟

## 背景

ADR-0033 的三步都已落地，按它的约定接下来发布 SDK 1.0。仓库现在的状况：

- **SDK 发不出去**：`@nextskin/plugin-sdk` 是 0.0.0，`exports` 指向 `src/index.ts`，`prepublishOnly` 拦着发布；`build` 只生成给 api-extractor 读的声明文件。Node 不对 `node_modules` 里的 `.ts` 做类型剥离，照现在的样子发出去，插件在构建时就加载不了。
- **构建命令是私有的**：第三方插件要用 `nextskin-plugin build` 打成插件包才能上传（ADR-0033），但 `@nextskin/plugin-cli` 是 private，还依赖 private 的 `@nextskin/plugin-host`（提取 manifest、包格式、模块钩子）。只发 SDK，仓库外的人写得出插件、打不成包。
- **插件 API 版本和 SDK 版本没有关系**：`PLUGIN_API_VERSION = '1.0.0'` 写死在 `plugin-host/src/manifest.ts`，manifest 的 `api` 一律是 `^1.0.0`。`PluginManifest` 的注释说 `api`"由构建时使用的 SDK 版本推出"，实际不是。SDK 1.1 加了事件以后，用了新事件的插件 manifest 里照样是 `^1.0.0`，1.0 的核心不会报"API 版本不兼容"，而是在 manifest 校验里报"未知事件"。
- **插件运行时用的是核心的 SDK 和 zod**：插件包不带它们，host 用自己那份（`PLUGIN_EXTERNALS`）。插件编译时看到的类型来自插件项目里装的 SDK，运行时拿到的 `z`、`definePlugin` 是核心的版本。`ctx.db` 的类型就是 Kysely 0.29 的类型（去掉几个方法），设置项写成 zod 4 的 schema，这两个库的 API 也是公开面的一部分。
- **变更记录**：`.changeset/` 里攒了 6 条（3 条 major、1 条 minor、2 条 patch），记的都是相对草案的改动。草案从没发布过。
- **其他**：仓库没有 LICENSE，是私有仓库；npm 上还没有 `@nextskin` 组织（维护者去注册）。SDK 的 doc 注释是中文。面向插件作者的文档还没有：`packages/plugin-sdk/AGENTS.md` 的"插件自有表的硬性规则""写插件表迁移时的坑"两节写明要进作者文档，ADR-0010 要求迁移指南写成"旧 Hook/Event/Filter → 新扩展点"的对照表，ADR-0033 要求逐一写明第一版迁移不过来的插件。
- **作者怎么测试**：核心还没有发行包（启动器没做），作者只能 clone 仓库、`pnpm dev`，在后台上传插件包。给作者用的测试工具 `packages/plugin-testing` 由 ADR-0033 推迟了。

2026-10-19 在仓库外的临时目录验证过：
- TS 7 加 `rewriteRelativeImportExtensions` 能从 `src` 生成 JS 和声明文件（JS 里的相对导入改成 `.js`，声明文件里保留 `.ts`）；
- TS 6 和 TS 7 在 `nodenext`、`bundler` 两种模块解析下、`skipLibCheck: false`，都能消费这些声明文件，类型检查邀请码插件的源码没有错误；
- 把 plugin-cli 连同它用到的 plugin-host 打成一个文件只有 40 KB，外部依赖只剩 rolldown、zod 和 SDK；用它在仓库外把邀请码插件构建成插件包，`unpackPluginPackage` 的校验通过。

要定的：发布哪些包、包的形状、API 版本怎么算、和 zod、Kysely 的关系、1.0 的变更记录、候选版、发布流程、文档、冻结前的最后调整、发布后的规则。

## 决定

### 发布两个包，版本号相同

| 包 | 内容 | 运行时依赖 |
|---|---|---|
| `@nextskin/plugin-sdk` | 类型，和少量运行时辅助函数（`definePlugin`、`table`、`secret`、`deny`、`z`……） | zod、kysely |
| `@nextskin/plugin-cli` | `nextskin-plugin build`。plugin-host 里提取 manifest、打包、模块钩子的部分，连同 SDK 和 zod，打进一个文件 | rolldown |

- **plugin-host 不发布**：它的导出是核心和 host 之间的内部接口。单独发布，就多了第三个要守兼容的公开面。
- **两个包放进 changesets 的 `fixed` 组，版本号永远相同。** 构建命令按名字列表校验插件用到的每一个事件、拦截点、能力，SDK 加了东西，构建命令必须跟着发版。版本号相同，作者只要记住"两个包装同一个版本"。构建命令单独修 bug 时 SDK 跟着出一个没有改动的补丁版本，没有坏处（见下一节 `api` 的取法）。
- **构建命令不用插件项目里的 SDK 运行时**：构建时插件代码里的 `@nextskin/plugin-sdk`、`zod` 由模块钩子换成构建命令自带的那份，和 host 运行插件时一样。构建命令只读插件项目里 SDK 的版本号，用来算 `api`：
  - 插件项目里的 SDK 比构建命令新、或者大版本不同，就报错，提示把两个包升到同一个版本；
  - 插件项目里解析不到 SDK，也报错。
- **构建命令的公开约定**，改了同样是大版本：
  - 命令和参数：`nextskin-plugin build [目录] [--out 文件]`；
  - 插件项目的约定：package.json 的 `nextskin` 字段和 `"type": "module"`，入口 `src/index.ts`，文案 `locales/<语言>.json`；
  - 插件包的格式：`manifestVersion: 1`。

### 包的形状

- **SDK**：
  - `build` 用 TS 7 生成 JS 和声明文件到 `dist`（`rewriteRelativeImportExtensions`）。声明文件不合成一个：拆开的已经验证可用。
  - 仓库里的 `exports` 仍然指向 `src`，核心和官方插件不用先构建；发布时由 `publishConfig` 换成 `dist`。`exports` 加上 `./package.json`，构建命令要读版本号。
  - 包里只有 `dist`、`docs`、README、CHANGELOG 和 LICENSE；`sideEffects: false`；`engines.node` 是 `>=24`（ADR-0013 的下限）。
  - 去掉拦着发布的 `prepublishOnly`。
- **构建命令**：`bin` 指向打好的 `dist/cli.mjs`。`engines.node` 同样是 `>=24`（构建时执行插件定义要用 `module.registerHooks`）。
- 两个包都只有 ESM。插件项目必须是 `"type": "module"`。

### 插件 API 的版本

- **插件 API 的版本就是 SDK 的版本号。** 核心的 `PLUGIN_API_VERSION` 改成从 SDK 的 package.json 读，`changeset version` 升 SDK 的版本，核心跟着变，不会忘。核心和 SDK 在同一个仓库里，核心实现的就是同一个提交里的 SDK。
- **manifest 的 `api` 取 `^主.次.0`**，主、次版本来自插件项目里装的 SDK。
  - 补丁版本不加东西（见"发布后的规则"），用 SDK 1.3.2 构建的插件，在实现 1.3.0 的核心上也能装。
  - SDK 是预发布版本（`1.0.0-rc.1`）时取完整版本号 `^1.0.0-rc.1`。核心的 semver 已经按 npm 的规则处理预发布版本：`1.0.0-rc.2` 满足它，`1.0.0` 也满足。
  - 次版本比核心新的插件装不上，报已有的 `plugin_api_incompatible`。作者想兼容旧一些的核心，就用旧的 SDK 次版本构建。
- 不按插件实际用到的东西推算最低版本：要给每个事件、字段记"从哪个版本开始有"，第一版不值得。

### zod 和 Kysely

插件编译时用 SDK 依赖的那一份，运行时用核心的那一份。两边对不上时，插件用了核心那份没有的 API，到运行时才失败。所以：

- SDK 对 zod、kysely 的依赖写成锁次版本的范围（`~4.6.7`、`~0.29.6`），和 pnpm catalog 里的次版本一致，由 SDK 的测试比对。
- 核心升级它们的次版本时，SDK 发一个次版本：依赖范围变了，插件能用的 API 多了。
- zod 的大版本、kysely 的次版本（0.x 的破坏性版本）是 SDK 的大版本。
- `renovate.json` 给 zod、kysely 加一条规则：在 Dependency Dashboard 里勾选才开 PR，说明里写明要附 SDK 的 changeset。

### 1.0 的变更记录

- 删掉现有的 6 条 changeset。它们记的是相对草案的改动，草案没发布过，对作者没有意义；内容留在 git 历史和 ADR-0033、0034 里。
- 换成一条 major：第一个正式版本，概述公开面（16 个事件、1 个拦截点、2 类 Provider、7 项能力、声明式 UI、插件表、KV、任务和定时任务、路由），链接到作者文档。两个包在 `fixed` 组里，一条 changeset 写两个包。0.0.0 加 major 得 1.0.0。

### 先发候选版

- 用 changesets 的预发布模式（`changeset pre enter rc`）发 `1.0.0-rc.N`，npm 的 dist-tag 是 `rc`，`latest` 不动。
- 候选期要做完：
  - 在仓库外，只用发布出去的两个包，照迁移指南迁一个仓库里没有的 BS 社区插件，同时检验文档；
  - 收集作者的意见。候选期里公开面照样可以改，照样附 changeset。
- 没有未决的公开面修改，就退出预发布模式（`changeset pre exit`），发 1.0.0。
- **1.0.0 发布之前，仓库公开**：作者文档引用的参考插件在 `plugins/*`，package.json 的 `repository` 指向仓库，npm 只给公开仓库发出的包生成来源证明（provenance）。候选版可以在仓库公开之前发。

### 发布流程

- **版本号在本地改**：`pnpm changeset version`，提交"发布插件 SDK x.y.z"，推到 main。仓库的提交直接进 main，不用 changesets 的 GitHub Action 开"Version Packages" PR。
- **CI 的发布工作流**（`.github/workflows/release.yml`）在推到 main、两个包的 package.json 变了时运行：
  - 两个包当前的版本在 npm 上都已经有了，就什么都不做；
  - 否则构建两个包、跑打包冒烟测试（下一节），然后 `changeset publish`，推 git 标签。
- **发布的凭据**：用 npm 的可信发布（OIDC，`id-token: write`），CI 里不放长期令牌。
  - 工作流放在 GitHub 的 environment `npm` 里，要维护者批准才运行；npm 那边的可信发布者也限定这个 environment。
  - npm 的组织 `@nextskin` 和每个包的可信发布者由维护者配置。npm 要求包先存在才能配可信发布的话，第一次（`1.0.0-rc.0`）由维护者在本地发，命令和 CI 里相同（根目录的 `pnpm release`）。
- 仓库公开之前发的版本没有来源证明。

### 打包冒烟测试

新的任务 `test:pack`，在 CI 的单独一个 job 里跑，发布工作流在发布之前也跑。它要联网安装依赖，不进 `pnpm check`。

1. `pnpm pack` 两个包，检查包里的文件清单（没有 `src`、测试和 fixtures）；
2. 在仓库外的临时目录，用 npm 安装这两个 tarball，不经过 workspace；
3. TS 6 和 TS 7、`nodenext` 和 `bundler`、`skipLibCheck: false`，类型检查一个只依赖这两个包的示例插件；
4. 用装好的构建命令构建它，再用核心的 `unpackPluginPackage` 和 manifest 校验读回来，核对 `api`。

### 作者文档

- **中文，放在 `packages/plugin-sdk/docs/`，随包发布。** 文档和它描述的 API 是同一个版本；插件作者，以及替作者迁移插件的 agent（ADR-0010），在 `node_modules` 里就能读到，不依赖仓库公开，也不用另外维护网站。
- README 是 npm 的页面：简介、最小的例子、文档目录。
- 篇目：
  - **入门**：建项目（package.json 的约定、装哪两个包）、写定义、构建、在本地的 NextSkin 上上传测试。
  - **扩展点**：能力、事件、拦截器、Provider、路由、声明式 UI、设置、任务和定时任务、KV、插件表。`packages/plugin-sdk/AGENTS.md` 的"硬性规则""坑"两节搬进插件表一篇，AGENTS.md 改成指向它。插件表一篇列出的白名单（运算符、函数、聚合、数据类型）由测试和网关的白名单比对。
  - **安全须知**：host 是安全带不是沙箱（ADR-0009），日志和错误消息里不写机密，Node 24 拦不住出站网络（ADR-0033）。
  - **从 BS 迁移**：旧 Hook、Event、Filter 到新扩展点的对照表（ADR-0010）；BS 官方插件的去向（ADR-0010 的表）；第一版迁移不过来的几类逐一写明：写核心数据、在浏览器里运行代码、验证码、连外部数据库、常驻连接（ADR-0033）。
  - **版本和兼容**：`api` 怎么算，两个包怎么升级，哪些变化算破坏性，开放的联合类型（见"发布后的规则"）。
- API 参考就是声明文件里的 doc 注释，不另外生成。
- `packages/plugin-sdk/examples/` 删掉：它们是草案时期的副本，和 `plugins/*` 重复。文档引用 `plugins/*`，入门一篇里的最小例子由 `type-tests` 类型检查。

### 冻结前的最后调整

2026-10-19 把 SDK 的每个导出和核心的实现逐项核对过一遍（独立审核，主会话复核）。一致的部分：
- 16 个事件都有发出点，DTO 的字段都有赋值；
- 能力裁剪、`user.register` 拦截器、两类 Provider 和类型、注释一致；
- 声明式 UI 的四种视图、六种字段、九种列格式都有渲染。

对不上的地方在发候选版之前处理，分四类。

**公开面的修改**（发布之后就要等 2.0）：

| 修改 | 原因 |
|---|---|
| `ctx.fetch` 的参数收窄成 `(url: string \| URL, init?: { method, headers, body })` | 核心只转发方法、地址、请求头和请求体，`redirect`、`signal`、`integrity` 这些选项写了也不生效。以后要支持哪一项再加，加可选的参数是次版本 |
| `entry.server` 改成必填 | 解包要求有服务端入口，构建命令也总是生成它。"纯声明式插件可以没有"的承诺做不到 |
| `texture.deleted` 的 `fileDeleted` 改名为 `lastReference`，注释改成有条件的 | 删除共用 hash 的条目同样发这个事件，这时为 false，`/textures/{hash}` 照常可用；为 true 时文件也不是马上删除 |
| 根入口改成逐个列出导出；`Has`、`Or`、`Gate`、`highRiskCapabilities` 不再导出 | 前三个是类型实现的细节，后一个是安装界面的风险分级，都不该让插件依赖 |
| 插件收到的字符串联合类型改成开放的：`UserRole`、`TextureType`、两个更新事件的 `fields`、`report.resolved` 的 `action`，类型上并入 `string & {}` | 以后加成员是次版本。只在注释里写"可能加成员"不够：作者照样会写穷尽的 switch，加成员之后编译失败，已经构建的插件在运行时走进"不可能"的分支。并入之后穷尽的 switch 编译不过，作者必须写默认分支；字面量的补全和比较不受影响 |
| `Actor` 保留 `plugin` 成员，注释写明第一版不会出现 | 它是对象的联合，没法用上一条的办法开放。写核心数据的能力落地后核心会产生它（ADR-0033 的推迟表），现在删掉，到时候加回来就是大版本 |
| `Field` 按 `type` 区分：`select` 必须有 `options`；`placeholder` 只在文本、多行文本、密码、数字上；`maxLength` 只在前三种上 | 现在写在别的类型上不生效，`select` 不写 `options` 就选不了 |
| public 路由的 `rateLimit.by` 只能是 `ip`；`detect` 至少写一项；`ctx.db` 顶层去掉 CTE（`with`、`withRecursive`）、`mergeInto`、`replaceInto`、`executeQuery` 这类网关一定拒绝的方法（实现时逐个核对） | 构建命令或网关本来就拒绝这些写法。能在类型上拒绝的，不留到构建或运行时（`packages/plugin-sdk/AGENTS.md`） |

**两个明确的例外**。"类型就是契约"（ADR-0033）在这两处做不到，支持的范围写进文档，作为契约的一部分，以后只放宽、不收紧：
- **查询构建器**：`ctx.db` 的查询构建器、迁移里的 `schema` 照旧是 Kysely 自己的类型。网关只支持其中一部分（S5 的白名单：一个 FROM 项加最多 4 个 JOIN，没有 RIGHT JOIN、`FOR UPDATE`、流式读取，函数和列类型有白名单）。要在类型上收窄，就得复制一份 Kysely 的类型，跟着它的版本维护。超出的写法在运行时被拒绝，并给出原因。
- **设置项的形状**：`settings` 照旧可以是任意的 `z.object`，核心只能给其中一部分生成控件（字符串、数字、布尔、字符串枚举、一层对象，机密只能是顶层的一项）。构建命令跑一遍核心加载插件时的同一套检查，不支持的写法在构建时就报错，不用等到安装。检查函数从 `packages/domain` 挪到 plugin-host。

**统一行为和承诺**（改核心）：
- `ctx.signal`：插件被停用、或者这次调用超时的时候 abort；换代（升级，或者别的插件启停引起的整代切换）时，在途的调用照常做完（ADR-0033）。现在官方插件停用时 abort，安装插件停用时等调用做完，统一成 abort。
- public 路由一律匿名：`scope.actor` 是 system，请求带着会话也一样。后台和用户中心的页面在服务端调用 public 的数据源时，同样不带用户。
- login Provider 的调用带上请求的语言，`ctx.t()` 默认用它，和其他请求内的调用一样。
- 路由的限流对所有入口生效：页面在服务端调用数据源时同样计数。插件升级改了限额，就换用新的限额。

**核心要修的问题**（不改公开面）：
- **声明式 UI 的路径能越出 `/plugins/{id}`**：`Action.route` 写成 `/../../api/admin/…` 能通过 manifest 校验，浏览器规范化路径之后，带着当前用户的会话请求核心的接口。插件不能在浏览器里借用户的身份（ADR-0011）。修法：manifest 拒绝 `.` 和 `..` 段，浏览器端拼好地址后再核对前缀。
- 数据源路径自带的查询参数和分页参数拼成了两个 `?`；行动作的占位符遇到不是字符串或数字的值时换成了空串，改成报错。
- 定时任务的 `payload: null` 被换成了 `{}`。
- 插件 id 和任务名各自合法，拼成的任务名却可能超过 128 个字符的上限。构建时检查。
- 插件版本和依赖范围有两套校验，接受的写法不一样。统一成一套，文档写明支持的范围语法。
- 对象里的枚举设置项没有用上 `options` 的文案。

**补齐注释和文档**：
- 每个方法的上限：`getMany` 最多 100 项，KV 键和 TTL 的范围，`enqueue` 的延迟和去重键，任务重试次数和超时的范围，事件 60 秒、路由 30 秒、迁移 60 秒的期限，deny 和日志的截断长度。
- 各种名字的正则。
- 列格式实际的渲染方式，`subject` 准确的字符范围，昵称和角色名的预填规则。
- 构建会执行入口模块的顶层代码。
- 引用 S5 的地方改成引用插件表一篇（S5 里还写着插件自己开事务）；事件的注释不再说可以用拦截器"修改"操作。

### 发布后的规则

在 `packages/plugin-sdk/AGENTS.md` 已有的分级上补充：

- **补丁版本**：只改注释、文档和构建命令的 bug，api-extractor 报告不变。报告有任何变化，至少是次版本。
- **联合类型**：
  - 插件收到的字符串联合类型都是开放的（并入 `string & {}`），次版本可以加成员。以后新增的这类字段也照此写。
  - 插件收到的对象联合（`Actor`）是封闭的，加成员是大版本。
  - 插件写给核心的联合类型（能力、视图、列格式、字段类型……）加成员是次版本。
- **构建命令里的 plugin-host**：plugin-host 是私有的，CI 的 changeset 检查只看发布的包自己的 `src`。改了打进构建命令的部分（提取 manifest、包格式、模块钩子），要给构建命令写 changeset。这一条写进 plugin-host 的 AGENTS.md。
- **废弃**：标 `@deprecated`，写明替代品，至少保留到下一个大版本（ADR-0010）。
- **大版本**：核心同时只实现一个大版本的插件 API。发大版本要另写 ADR，写明迁移方式。

### 许可证

整个仓库用 MIT，根目录加 LICENSE。两个包里各放一份（npm 只打包包目录里的 LICENSE），由测试比对和根目录的一致。第三方来源的代码和素材照现在的做法，在所在目录的 `THIRD_PARTY.md` 里保留原许可。

## 后果

- 1.0.0 发布之后公开面冻住：删除、改名、收窄都要等 2.0。候选期是最后一次免费修改的机会。
- 核心每升一次 zod 或 kysely 的次版本，SDK 都要发一个次版本。
- 作者在核心有发行包之前，只能 clone 仓库、`pnpm dev`、在后台上传测试。启动器和发行包落地后，入门一篇跟着改。
- CI 多一个要联网的 job；发布要维护者在 GitHub 上批准一次。
- 要做的：
  - 两个包的打包、`publishConfig`、`fixed` 组、构建命令读 SDK 版本、`PLUGIN_API_VERSION` 改从 SDK 读；
  - `test:pack`、发布工作流、`pnpm release`、renovate 规则；
  - 作者文档和 README，`packages/plugin-sdk/AGENTS.md` 的"当前状态"一节；
  - LICENSE；
  - 换掉 changeset，进入预发布模式；
  - 冻结前的调整：公开面的修改附在那条 major changeset 里，核心的修复各自带测试；
  - `PROGRESS.md` 和 AGENTS.md 的"当前阶段"。

## 考虑过的其他方案

- **只发 SDK，构建命令以后再说**：第三方插件打不成包，等于没发。
- **把 plugin-host 也发布，构建命令依赖它**：plugin-host 的导出是核心和 host 之间的内部接口，发布了就多一个要守兼容的公开面。
- **把构建命令放进 SDK 包**：SDK 就要依赖 rolldown（带原生绑定的打包器），只要类型的人也得装它。
- **两个包各自独立版本**：构建命令要声明自己支持 SDK 的哪个范围，作者要查对照表。
- **构建命令用插件项目里的 SDK 运行时**：要把 SDK 写成构建命令的 peer 依赖；运行时和插件在核心上实际拿到的那份也不一致，不如和 host 一样用自带的。
- **`api` 取完整版本号（`^1.3.2`）**：每个只改注释的补丁版本，都会让新构建的插件装不上稍旧的核心。
- **不发候选版，直接发 1.0.0**：仓库外还没有人用过这两个包，冻住之后才发现问题，只能升大版本。
- **changesets 的 GitHub Action 开"Version Packages" PR**：仓库没有 PR 流程，提交直接进 main。
- **文档放在仓库的 `docs/` 或单独的网站**：仓库公开之前作者看不到；网站要另外部署，版本也和包对不上。
- **用 api-extractor 把声明文件合成一个**：拆开的已经验证可用，合成要多一步配置。
- **开放的联合类型只在注释里说明**：类型照旧允许穷尽的 switch，加成员时作者的代码照样编译失败。
- **删掉 `Actor` 的 `plugin` 成员**：符合"只包含核心已经实现的东西"，但写核心数据的能力落地时就要升大版本。
- **在类型上收窄查询构建器**：要复制、维护一份 Kysely 的类型；白名单写进文档、运行时拒绝，效果相同。
- **先写英文文档或中英双语**：BS 的社区主要说中文，SDK 的 doc 注释也是中文。以后再加英文。
