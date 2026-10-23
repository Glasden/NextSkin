# CI 与 PR 检查

PR 要等 CI 全部通过才会合并（什么改动走 PR 见 ADR-0047）。这份文档写 CI 跑了什么、提 PR 之前本地该跑什么、各项检查失败时怎么看、怎么修。条目都来自实际出现过的失败；踩到新的坑，在对应小节补一条。

## CI 跑了什么

定义在 `.github/workflows/ci.yml`。每个任务都在干净的环境里从头跑，不用 Turborepo 缓存：本地因为缓存命中而跳过的任务，到 CI 上照样会跑。

| 任务 | 命令 | 本地需要 | 内容 |
|---|---|---|---|
| `check (Node 26)` | `pnpm check` | | lint、类型检查（TS 7）、单元测试和 story 测试、契约回放、格式检查 |
| `test (Node 24)` | `pnpm turbo run test` | Node 24 | engines 的下限，只跑测试 |
| `test:db` | `pnpm test:db` | Docker | `*.db.test.ts` 在 SQLite、MySQL、MariaDB、PostgreSQL 上各跑一遍 |
| `build + e2e` | `pnpm e2e`，再跑 `packages/launcher/docker/smoke.sh` | 镜像冒烟要 Docker | 先构建（含构建涉及的每个包的类型检查），从 `dist/nextskin` 经启动器起服务跑 Playwright；再用发行目录构建镜像冒烟 |
| `test:visual` | `pnpm test:visual` | Docker | 每个 story 拍亮色、暗色、亮色加结构全开三张截图，和 `packages/ui/visual/__screenshots__` 的基线比较 |
| `test:pack` | `pnpm test:pack` | 联网 | 在仓库外安装打出来的 SDK 和构建命令，构建一个插件 |
| `changeset` | `pnpm changeset status` | | `packages/plugin-sdk/src`、`packages/plugin-cli/src` 有改动（测试文件也算）就必须附 changeset |

- 只改了 `*.md`、`docs/**`、`spikes/**` 的 PR 和推送不触发 CI。
- 同一个 PR 推了新提交，还在跑的旧运行会被取消。
- PR 上显示跳过的"合并的内容是否已在 PR 上测过"只在推送到 main 时运行，不用管。

## 提 PR 之前

`pnpm check` 每次都要跑，其余按改动挑：

| 改了什么 | 再跑 |
|---|---|
| `packages/db`、迁移、`packages/domain` 里的查询 | `pnpm test:db` |
| 页面、`apps/web`、Next 配置，或者页面用到的组件和文案 | `pnpm e2e` |
| `packages/ui` 的组件外观或 story | `pnpm test:visual` |
| `packages/plugin-sdk`、`plugin-cli`、`plugin-host` | `pnpm --filter @nextskin/plugin-sdk api:update`、`pnpm changeset`、`pnpm test:pack` |

- `pnpm check` 在第一个失败的任务处停下。想一次看到全部失败，加 `--continue`。
- 机器同时在干别的（编译、开游戏）时，`pnpm check` 会大面积超时（`Hook timed out`、子进程被杀）。用 `pnpm check --continue --concurrency=1` 重跑，还挂的才是真问题。
- 本地没有 Docker 就跑不了 `test:db`、`test:visual`，推上去看 CI 的结果。失败了按下面的小节修，不要改测试或基线去迁就当前的输出。
- Windows 上：`packages/domain` 的 `textures/storage.test.ts` 有几个用例要建符号链接，账号没有这个权限（没开开发者模式）时自动跳过。e2e 默认监听 3100–3105，Windows 的动态端口范围可能覆盖到这里，被代理客户端、游戏这类程序的连接占着时报 `listen EACCES`，见下面"e2e"一节换端口。

## 看失败的日志

- 在 PR 的 Checks 里点开失败的任务，找第一个 `##[error]`，或者看任务页上的 annotations。
- turbo 并行跑多个包，一个失败之后其余任务被打断，后面成串的 `ELIFECYCLE … SIGINT` 是连带结果，不是另一个问题。
- 几个任务同时挂时先看 `check (Node 26)`：i18n、单元测试这类问题会让 `test (Node 24)` 一起挂，修一处两边都好。
- 挂的是和改动无关的文件，而且是超时（`Test timed out`、`Matcher did not succeed in time`）或时序断言，先重跑失败的任务（Re-run failed jobs），见"偶发失败"。

## 常见失败

### 格式检查

`[warn] Code style issues found in N files`，前面几行列出了文件：

```bash
pnpm exec prettier --write <报出来的文件>
```

- 编辑器装 Prettier 插件、保存时格式化，读仓库的 `.prettierrc.json`。`*.md` 不在检查范围内。
- **Windows**：Git for Windows 默认 `core.autocrlf=true`，把文件检出成 CRLF；Prettier 要 LF，本地 `prettier --check .` 会报出几乎所有文件。提交时 Git 会转回 LF，CI 上不会出现，不要为此 `pnpm format` 整个仓库。本地只检查自己改过的文件：`pnpm exec prettier --check <文件>`。想让全仓检查也干净，就在这个仓库里 `git config core.autocrlf input`，先提交或贮藏改动，再 `git rm --cached -r -q . && git reset --hard` 重新检出。

### i18n 文案

`packages/i18n/src/messages.test.ts` 要求每条文案都是合法的 ICU 消息，`zh-CN.json` 和 `en.json` 的键、参数完全相同。

- 文案里像标签的 `<server-key>`、字面的 `{` `}` 要用单引号括起来：`'<server-key>'`、`'{'`。不括会被当成标签或参数，报 `UNCLOSED_TAG` 一类的语法错误。
- 两种语言同时写，只加一种时键不相同。

`errors` 和 `admin.errors` 是给接口错误码配的文案（ADR-0019），`packages/api/src/rest/admin-users.test.ts` 要求 `admin.errors` 的每个键都是 REST 接口的错误码。界面自己的提示（比如表单的"请填写这一项"）放在页面的命名空间下，放进这两处会让测试挂掉。

### 设计文档和 token

`packages/ui` 的 `design-doc.test.ts`、`tokens.test.ts`：

- 新组件（带 story 的目录）要在 `docs/DESIGN.md` §6 的组件表里补一行。
- 改了 `packages/ui/src/theme.css` 或标志的图形，跑 `pnpm design:sync`，把 `docs/DESIGN.md` 和 `apps/web/public` 的改动一起提交。

### 插件 SDK

- **API 报告**：改了 `packages/plugin-sdk/src` 之后跑 `pnpm --filter @nextskin/plugin-sdk api:update`，把 `packages/plugin-sdk/etc/plugin-sdk.api.md` 一起提交。只改注释也要跑：报告里带着 `.d.ts` 的行号。单跑 `pnpm --filter @nextskin/plugin-sdk test` 读的是上次构建的 `dist`，本地可能误报通过，以 `pnpm check` 为准。
- **changeset**：`Some packages have been changed but no changesets were found`。`src` 有改动就跑 `pnpm changeset` 写一份；只改了 `src` 里的测试这类不需要发版的改动，用 `pnpm changeset --empty`。公开 API 的改动还要过 `packages/plugin-sdk/type-tests`，见该包的 AGENTS.md。
- **test:pack**：npm 包里只能有白名单里的文件。`packages/plugin-sdk/docs/` 整个随包发布，里面只放平铺的 `.md`；建了子目录（比如草稿目录）test:pack 就会失败，草稿放到包外。

### 截图回归

- 失败的运行会上传 `visual-diff`（`packages/ui/test-results/`），下载后对比 expected、actual、diff 三张图。
- 改了共用组件，用到它的 story 都会变：改 `Field` 时，`Form`、`Dialog` 的截图也要跟着更新。
- 外观改动是有意的：`pnpm test:visual -- --update-snapshots`，逐张看过新截图再提交。浏览器跑在 Docker 里，本地拍的基线和 CI 一致。
- 只挂了一两张、和改动无关、重跑就过的，多半是焦点框、弹层退场这类时序问题，见"偶发失败"。

### e2e

- 用例按界面文案找元素，比如后台保存设置后断言"已保存 3 项设置"。改共用的表单组件（`Field`、`Form`）、表单校验或文案，会牵动所有表单页的用例。
- 断言超时先看失败用例的 `error-context.md` 和截图，确认页面实际停在哪里、接口返回了什么。多半是行为变了，不要先加等待时间。
- 只重跑一个文件：`pnpm build` 之后 `pnpm --filter @nextskin/web exec playwright test e2e/admin.spec.ts`。用例跑的是 `dist/nextskin`，改了代码要重新构建。
- 六个服务依次监听 3100–3105。端口被占（`listen EACCES`、`EADDRINUSE`）时设 `NEXTSKIN_E2E_PORT=<基准端口>` 换一组连续的端口。Windows 上要避开动态端口范围（`netsh int ipv4 show dynamicport tcp`）。
- 每次运行在系统临时目录建的数据目录，结束时自动删除。要保留现场，自己设 `NEXTSKIN_E2E_DATA_DIR` 这类环境变量指定目录（见 `playwright.config.ts`），指定的目录不删。
- 用 `--repeat-each` 复现偶发时，注册账号的用例同一个 IP 超过注册名额会返回 403，看起来像大面积失败，和改动无关。

### 数据库测试

- `pnpm test:db` 带着 `--continue`：`packages/db` 失败时 `packages/domain` 照样跑完，一次看到全部失败。
- 只重跑一种库：在 `packages/domain` 里 `pnpm exec vitest run --config vitest.db.config.ts --project db:postgres <文件>`（项目名是 `db:sqlite`、`db:mysql`、`db:mariadb`、`db:postgres`，容器要先由 `pnpm test:db` 起好）。
- PostgreSQL 的字符串排序跟区域设置走，只差大小写的字符串排出来和另外三种库不同。测试里比较列表时在 JS 里排序，不要依赖 `ORDER BY`。
- 加了新迁移，断言"最新迁移是某一号"的旧测试会失败。这类测试只迁移到它关心的那一号为止。
- `returning`、upsert、自增主键、`count` 只能通过 `packages/db` 的辅助函数使用（不变量 6），直接写在某一种库上能过、另外几种会挂。

### 只在 Node 24 上挂

`test (Node 24)` 挂、`check (Node 26)` 通过的，先查是不是用了 Node 25 以后才有的 API（engines 的下限是 24），再按偶发失败处理。

### 偶发失败

CI 的 runner 比开发机慢，下面这些在 main 上出现过，重跑能过：

- 起子进程的测试超时（启动器、plugin-cli、plugin host）；
- 契约回放里依赖 1 秒节流窗口的场景；
- story 里等图片解码，或者弹层关闭后马上断言焦点。

重跑能过就不必在自己的 PR 里处理。同一个用例反复挂，在 PR 里说明，或者单独修：等待写成带上限的 `waitFor`，弹层关闭后先等卸载再断言焦点，超时按慢机器放宽，不要靠固定的 sleep。
