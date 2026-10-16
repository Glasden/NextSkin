# S1：Better Auth 能否承载 Yggdrasil Connect

**结论：可以。** Better Auth 1.7.10 加 `@better-auth/oauth-provider` 1.7.10，再配约 400 行胶水代码，就能实现 Yggdrasil Connect 的全部必选能力。这些能力在 SQLite（node:sqlite）、PostgreSQL 17、MySQL 8.4 上用端到端测试验证过（23 项）。其中有一处依赖了未公开的内部结构，另有两处需要绕开 Better Auth 的设计假设，详见下文。

对应 ADR：`docs/adr/0007-auth.md`。协议规范：authlib-injector issue #268。

## 运行

```bash
npm ci
DB=sqlite npx tsx src/scenario.ts
DB=postgres PG_URL=postgres://... npx tsx src/scenario.ts
DB=mysql MYSQL_URL=mysql://... npx tsx src/scenario.ts
npx tsc -p tsconfig.json
```

| 文件 | 内容 |
|---|---|
| `src/auth.ts` | Better Auth 配置 |
| `src/yggdrasil-connect.ts` | 全部胶水代码：scope 规则、角色绑定、claims、设备流包装、进服校验 |
| `src/scenario.ts` | 端到端场景，后半部分是审核发现的问题的回归用例 |

## 验证了什么

| 需求 | 实现方式 | 结果 |
|---|---|---|
| 整数自增用户主键、自定义表名 | `advanced.database.generateId: 'serial'`；`user.modelName` | ✅ 三种数据库都通过。**主键列名不能改，只能叫 `id`** |
| node:sqlite | `@better-auth/kysely-adapter/node-sqlite-dialect` 提供的 `NodeSqliteDialect` | ✅（S2 的结论是核心不用这个方言，见 `spikes/s2-node-sqlite/`） |
| 旧版 bcrypt（`$2y$`）登录并重新哈希 | `emailAndPassword.password.verify` 加 after 钩子 | ✅ 密码存在 `account` 表，不在用户表 |
| RS256 签名的 ID 令牌、JWKS、`kid` | `jwt({ jwks: { keyPairConfig: { alg: 'RS256' } } })` | ✅ |
| 发现文档：三个 Yggdrasil scope、`device_authorization_endpoint`、`shared_client_id` | `scopes` 加扩展的 `metadata` | ✅ |
| scope 组合规则 | before 钩子覆盖 authorize（GET 和 POST）、consent 的 scope 子集、device/code、refresh | ✅ |
| 授权时选择角色，访问令牌绑定角色 | 同意页提交时用 `x-ygg-profile` 请求头带上 pid，作为 consent 的 `referenceId`（`player:<pid>`） | ✅ |
| ID 令牌和 userinfo 带 `selectedProfile` / `availableProfiles` | 扩展的 `claims.idToken` / `accessToken` / `userInfo` | ✅ |
| 刷新后绑定不变；旧刷新令牌不能重用 | `referenceId` 随刷新令牌保存 | ✅ |
| 只有申请 `offline_access` 才发刷新令牌 | 内置行为 | ✅ |
| 设备代码流（RFC 8628）并绑定角色 | 包装内置 device_code grant，补上 `referenceId` | ✅ |
| 公共客户端每次都要征求同意 | authorize 的 before 钩子强制 `prompt=consent` | ✅ |
| 会话服务器（进服）校验令牌 | 按 sha256 直接查令牌表（`storeTokens.hash` 由我们指定） | ✅ |

## 设计结论（写入 ADR-0007）

1. **在同意页上选择角色，不另设 postLogin 页面。** 申请 `Yggdrasil.PlayerProfiles.Select` 时，每次授权都强制进入同意页。同意请求的 before 钩子在同一个请求里完成三件事：校验最终接受的 scope、校验角色归属、把角色写进本请求的 session；随后 Better Auth 在同一请求内计算 `referenceId`。
   - 不能把选择存在 session 里、到同意时再读：同一用户并行的两个授权流程会串用对方的选择（见审核发现 1）。
2. **设备流的选择按 `device_code` 字符串记录**，不能按自增 id：SQLite 会复用已删除行的 id。只允许认领者在待批准状态下选择或更改；兑换或拒绝后删除选择记录。
3. **进服校验不走 introspection。** introspection 要求调用方是签发令牌的客户端或其关联资源，会话服务器两者都不是。我们用自己指定的 sha256 查令牌表，并同时检查：
   - 令牌带 Join scope；
   - 已绑定角色；
   - 这个角色此刻仍归属于令牌的用户；
   - 客户端没有被禁用。
4. **Better Auth 的 `database.transaction` 默认是 `false`**，必须显式打开，否则它的多步写入不在同一个事务里。
5. 启动器客户端要注册为 `application_type: 'native'`，才能使用 `http://127.0.0.1` 回调地址；`web` 类型强制要求 https。
6. 创建 OAuth 客户端的管理接口要求有登录会话（客户端归属于创建者），由站点管理员在后台创建。

## 独立审核发现的问题与修复

审核由 Codex（`gpt-6-astra`，xhigh）执行。它在输出最终结论时被 OpenAI 的内容安全过滤拦截，但审核过程中写的探测脚本已经全部运行，结果由主会话逐条复现确认。下表每一项都已修复，并在 `scenario.ts` 里有对应的"回归"用例。**修复后没有再做独立复审。**

| # | 问题 | 后果 | 修复 |
|---|---|---|---|
| 1 | 同一用户并行的两个授权流程，后选的角色会覆盖先选的 | 令牌绑定到错误的角色（同一用户内） | 角色在同意请求内选择并绑定（结论 1） |
| 2 | 同意时只接受部分 scope（丢掉 Select、保留 Join）：钩子拒绝之前，同意记录已经写库；随后 POST 形式的 authorize 不经过 scope 校验，可以拿到"有 Join、无绑定角色"的令牌 | 违反规范的 scope 组合 | consent 钩子在写库之前校验；authorize 同时校验 query 和表单请求体 |
| 3 | 刷新时缩小 scope 不受组合规则约束 | 同上 | token 端点的 refresh 也做校验 |
| 4 | 公共客户端的强制同意可以用 POST 加空的 `oauth_query` 绕过；`prompt=none` 被改写成 `consent` | 静默授权 | 按请求 URL 判断是否内部续跑；`prompt=none` 直接返回 `consent_required` |
| 5 | 设备码批准后还能更换角色 | 绑定在批准后被改变 | 只允许在待批准状态下选择 |
| 6 | 改写格式的 user code（小写、加连字符）能绕过"批准前必须先选角色"的检查 | 批准时没有选角色 | 按 Better Auth 相同的规则规范化后再查找 |
| 7 | 选择记录按自增 id 存储且兑换后不删；SQLite 复用 id 后，新设备码会继承旧设备码的选择 | 令牌绑定到用户从未在这次授权中选过的角色 | 按 `device_code` 字符串存储，兑换或拒绝后删除 |
| 8 | 进服校验不检查角色是否仍归属于用户、是否带 Join | 角色转让后旧令牌仍可进服 | `verifyJoinToken` 补齐四项检查（结论 3） |
| 9 | userinfo 没有 `availableProfiles` | 违反"userinfo 是 ID 令牌声明的超集" | userinfo claims 补上 |

跨用户的绑定在修复前也被 claims 钩子里的归属复查挡住了：ID 令牌签发会失败。但访问令牌行在 ID 令牌之前就已写入，所以进服校验必须自己再查一次（第 8 项）。

## 需要上游改进的地方（建议提 issue / PR）

1. **设备流的 `issueTokens` 没有传 `referenceId`。** 我们通过包装内置 grant 绕过，依赖的是 `oauthDeviceAuthorization().options.grant.grants` 这个未在类型里公开的结构。升级 Better Auth 时，靠本目录的场景测试兜底。
2. **`postLogin.consentReferenceId` 拿不到当前授权请求的上下文**，只有 user、session、scopes。所以"每个授权流程各自的选择"只能在同意请求里完成。
3. **同意或继续之后，Better Auth 会以 `/oauth2/authorize` 路径在内部重新调用 authorize，同样会触发 before 钩子。** 钩子必须自己区分外部请求和内部续跑（我们按请求 URL 判断）。
4. scope 校验失败时，我们的钩子返回 JSON 400，而不是按 RFC 6749 §4.1.2.1 重定向回 `redirect_uri`。要做到后者，需要先校验客户端和回调地址，最好由上游提供"自定义请求校验"扩展点。

## 没有覆盖的内容

- 旧 Yggdrasil authserver（用户名密码直接换令牌）与 OAuth 令牌体系如何统一：留到实现阶段决定。
- pairwise subject、动态客户端注册、签名密钥轮换、令牌数量上限、限流。
- 同意页 UI 本身。
