# ADR-0034 第三方登录：一家一个插件；绑定存进 `accounts`，一个第三方账号只绑一个用户；邮箱撞上已有账号不自动绑定；首次登录经过注册用例；开了两步验证照样要过第二步

- 状态：已采纳
- 日期：2026-10-19
- 取代 ADR-0010、ADR-0033 里"oauth 和四个提供商插件合并成一个第三方登录插件"的部分：改为一家一个插件
- 补充 ADR-0033：卸载插件时一并删除它名下的绑定；第三方登录的参考插件是 `oauth-github`
- 补充 ADR-0023：第三方登录也要过两步验证；没有密码的账号可以设置密码；Better Auth 自带的账号端点关掉

## 背景

ADR-0033 把第三方登录留在第三步，要求先写 ADR 再做核心和插件；首次登录建号也要经过注册用例，否则从第三方登录就能绕过邀请码。SDK 里已经有 `login` Provider 的草案（`providers.ts`）：

- `authorizeUrl({ state, codeChallenge, redirectUri, ctx })` 返回跳转地址，`exchange({ query, codeVerifier, redirectUri, ctx })` 返回 `ExternalIdentity`（`subject`、`email`、`emailVerified`、`displayName`、`avatarUrl`）；
- state、PKCE、账号绑定、会话创建都由核心处理，插件只负责和第三方交换身份；
- manifest 只登记 Provider 的 id、label、icon（`plugin-host/src/manifest.ts`）；安装界面已经把 `provider.login` 列为高风险（`plugins/admin.ts`）。

BS 6.0.2 的第三方登录是 oauth 插件（1.0.6）加 oauth-github、oauth-google、oauth-microsoft-live、oauth-littleskin，基于 Laravel Socialite：

- 发起和回调是 `/auth/login/{driver}` 和 `/auth/login/{driver}/callback`，凭据写在 `.env`（`GITHUB_KEY` 等）；
- **只按邮箱匹配用户，没有绑定表**。第三方返回的邮箱是谁的，就登录谁的账号，不看第三方有没有验证过这个邮箱；
- 邮箱不存在就直接建号：密码为空串，邮箱标成已验证，昵称取第三方的昵称或名字。不检查注册开没开、同一 IP 的注册数，邀请码插件也拦不住；
- 第三方没有给邮箱就报 500。

导入器（ADR-0031）遇到空密码不建 `credential` 那一行，报告里记作"密码哈希认不出"。所以从 BS 导入的、经第三方登录建的账号，在新站上没有任何登录方式，只能找回密码。

Better Auth 1.7.10：
- 自带 `socialProviders` 和 `genericOAuth`：令牌交换在核心里做，回调里由它自己建用户，邮箱已验证时按 `accountLinking` 自动绑定已有账号；
- `generateState` / `parseState`（`better-auth/oauth2`）：state、code_verifier 和回跳地址存进 `verifications`（10 分钟），同时写一个签名 Cookie（5 分钟），回调时两者对上才继续，用过就删；
- 两步验证插件的 after 钩子只匹配 `/sign-in/email`、`/sign-in/username`、`/sign-in/phone-number`，所以它自带的第三方登录不经过第二步；
- `/unlink-account`、`/list-accounts`、`/link-social`、`/get-access-token`、`/refresh-token`、`/account-info` 现在都是开着的。有了第三方绑定之后，`/unlink-account` 能删掉自己的 `credential` 行（密码）；
- `setPassword` 只能在服务端调用，给没有密码的账号建 `credential` 行；找回密码遇到没有 `credential` 行的账号时，也会新建一行。

`accounts.account_id`、`provider_id` 是 `text`，没有唯一索引。

## 决定

### 一家一个插件

每个第三方（身份提供商）一个插件。SDK 仍然允许一个插件声明多个 `login` Provider，但官方插件各声明一个。

| 理由 | 说明 |
|---|---|
| 按钮的显隐不需要新机制 | 登录页同时放好几家的按钮，核心要知道哪几家能用。合并成一个插件，就要给 SDK 加"按设置决定可不可用"的声明，或者在核心里另做逐家的开关、和插件设置里的凭据分在两处。一家一个时，插件启用、设置通过校验，按钮就出现（见"登录页"） |
| 绑定按插件划分，打包方式以后改不动 | 绑定的键带着插件 id（见下）。以后拆分或合并插件，已有的绑定全部对不上 |
| 和第三方插件一致 | QQ、微信、Discord 这类只会由第三方各写一个插件 |
| 授权最小 | 出站白名单和机密设置按插件划分，只启用 GitHub 就只放行 GitHub 的地址 |

几家共用的代码（拼授权地址、换令牌、读 ID 令牌和用户信息、错误映射）放进一个不发布的 workspace 包 `packages/oauth-client`，`nextskin-plugin build` 把它打进每个插件的单文件里。它不是 SDK 的一部分，第三方插件不能依赖它。

### 首批插件

| 插件 id | 第三方 | 出站 origin | subject | `emailVerified` |
|---|---|---|---|---|
| `oauth-github` | GitHub OAuth App | `https://github.com`、`https://api.github.com` | 数字 `id`：登录名可以改 | `/user/emails` 里 primary 的那个是否 verified（scope `user:email`） |
| `oauth-microsoft` | Microsoft 个人账号（`consumers` 租户） | `https://login.microsoftonline.com` | ID 令牌的 `oid`：`sub` 按应用注册区分，管理员重建应用后会变 | 一律 `false` |
| `oauth-google` | Google | `https://oauth2.googleapis.com` | ID 令牌的 `sub` | ID 令牌的 `email_verified` |
| `oauth-littleskin` | LittleSkin（`littleskin.cn`，BS 的 OAuth 服务端） | `https://littleskin.cn` | `/api/user` 的 `uid` | `/api/user` 的 `verified` |

- Provider id 依次是 `github`、`microsoft`、`google`、`littleskin`。每个插件的设置只有客户端 ID 和客户端密钥（`secret()`），不申请任何能力，只声明出站 origin。
- Microsoft、Google 的 ID 令牌直接从令牌端点拿到，按 OIDC Core 3.1.3.7 可以用 TLS 代替验签，但要核对 `iss` 和 `aud`。这样两家都只需要一个出站 origin。
- Microsoft 只接个人账号：Minecraft 用的就是个人账号，BS 的 oauth-microsoft-live 也只支持个人账号。工作和学校账号的 `email` 由租户管理员填写、未经验证，而且还要处理租户配置。
- 各家的字段在实现时用真实账号核对一遍，表里的选择以核对结果为准。subject 一旦有用户绑定就不能再换。
- `oauth-github` 是 ADR-0033 要求的参考插件，另外三个是普通官方插件，测试见"测试"。

### 绑定

- 绑定存进 Better Auth 的 `accounts`：`provider_id` 是 `plugin:<插件 id>:<Provider id>`，`account_id` 是 subject。令牌各列留空：核心用不到第三方的令牌，存着只多一份要保护的机密。`exchange` 也不返回令牌。
- 键里带插件 id：一个插件只能给出自己名下的身份，冒认不了别的插件的用户；不同第三方的数字 id 也会撞上。
- 两个唯一索引，四种数据库上由数据库保证：
  - `(provider_id, account_id)`：一个第三方账号只绑一个用户；
  - `(user_id, provider_id)`：一个用户在每个 Provider 上只绑一个第三方账号。`credential` 每个用户本来就只有一行。
- 迁移把这两列改成 `authStringType(255, { ascii: true })`（SQLite 上仍是 `text`，MySQL 上用 ascii 字符集，两列合计 510 字节，远低于单个索引 3072 字节的上限），再建上面两个索引。两列的值都只有 ASCII：`credential` 行的 `account_id` 是 uid，插件 id 和 Provider id 的正则只允许 ASCII，subject 见下一条。
- 核心校验 `exchange` 的返回值：subject 是 1 到 255 个可打印的 ASCII 字符（`[\x21-\x7e]`），不通过就按插件出错处理。这样也避开了 MySQL 比较时忽略末尾空格的问题。`login` 的 Provider id 在 manifest 现有的规则之外，再限制在 64 个字符以内。
- 插件停用：绑定保留，登录页上的按钮去掉，这些用户暂时不能用它登录。
- 插件升级后去掉了某个 `login` Provider：升级确认里列出它和它名下的绑定数，绑定保留。
- 插件卸载：它名下的绑定和插件的设置等一起，在同一个事务里删除（补充 ADR-0033 的卸载范围）。没有插件市场替插件保留 id，之后装上来的同 id 插件可能对接的是另一个第三方，subject 会撞上别人的绑定。卸载确认里列出删除后没有任何登录方式的用户数，这些用户只能用找回密码登录。

### SDK 的改动

- `ExternalIdentity` 删 `avatarUrl`：站内头像来自材质；直接显示第三方的头像地址，会把访客的 IP 交给第三方，还要给 CSP 开口子。`users.image` 不再写入。SDK 还没发布，现在删掉没有代价。
- `subject`、`emailVerified` 的说明写清楚：
  - subject 在第三方那里永远指同一个人，不用登录名或邮箱；
  - `emailVerified` 只在第三方确认这个人此刻拥有这个邮箱时才是 `true`，拿不准就填 `false`。核心靠它决定新账号的邮箱算不算已验证，以及能不能绑定没有任何登录方式的账号（见"首次登录"）。
- Provider id 要永远对应同一个第三方：改名会让已有的绑定失效，拿去对接别的第三方会让 subject 撞上别人的绑定。
- 期限：`authorizeUrl` 5 秒，`exchange` 15 秒（GitHub 要发三个请求）。超时、抛错、返回值不合格，都按这次登录失败处理；连续失败的 Provider 在冷却期内不再调用，和 passwordHasher 相同。
- 回调带 `error` 参数时（RFC 6749 §4.1.2.1，例如用户在第三方点了取消），核心直接按取消处理，不调用 `exchange`。
- `user.register` 拦截器的说明补一句：第三方登录首次建号也调用它，输入相同；`extra` 是"完成注册"页上的插件字段。
- 附 changeset，更新 api-extractor 报告和 type-tests。

### 发起和回调

- 由我们自己的一个 Better Auth 插件提供端点。签发会话要用 Better Auth 的 `internalAdapter.createSession` 和 `setSessionCookie`，和两步验证、通行密钥签发会话的方式一样。
  - `POST /api/auth/plugin-login/{插件 id}/{Provider id}`，请求体 `{ intent: 'signIn' | 'link', next? }`，返回第三方的授权地址。用 POST 是为了经过 Better Auth 的 Origin 校验。`link` 要求会话是新鲜的（见"绑定和解绑"）。
  - `GET /api/auth/plugin-login/{插件 id}/{Provider id}/callback` 是回调地址（`redirectUri`），后台的插件详情页按站点地址拼出完整地址，供管理员填到第三方的控制台。
  - 插件没有启用、设置没有通过校验、Provider 不存在，都返回 404。
- state、code_verifier、`next`、`intent` 和绑定时的 uid 用 Better Auth 的 `generateState` / `parseState` 保存。`codeChallenge` 总是按 S256 生成；第三方不支持 PKCE 时，插件可以不传它，state 照样防 CSRF。
- `next` 只接受站内的相对路径，规则和登录页现有的一样。
- 调插件、发网络请求都在事务之外，事务里只写绑定或注册（ADR-0008）。
- 日志只记插件 id、Provider、阶段（authorize / exchange）、结果和耗时。不记插件抛出的消息、回调的查询串、第三方返回的邮箱：里面可能有授权码或令牌（不变量 11）。
- 出错时跳回 `/sign-in?error=<code>`，页面显示对应的文案。

### 登录（已经绑定）

- 按 `(provider_id, subject)` 找到用户。被封禁的用户照常登录，只看到封禁说明，和密码登录相同（ADR-0022）。
- **开了两步验证就要过第二步。** 两步验证是用户自己为这个账号加的保护，换一种第一步不应该把它绕过去；第三方账号本身可能比这里的密码还弱。GitLab 默认也这样做。通行密钥不受这条约束（ADR-0023），因为通行密钥绑定站点，钓鱼骗不走；第三方登录没有这层保证。
  - 实现上先照常签发会话，再直接调用两步验证插件的 after 钩子：它的 matcher 只认密码登录的路径，handler 本身不看路径。开了两步验证时，它删掉会话，换成第二步的挑战（同一个 Cookie、同样的验证记录），"信任这台设备"也照样有效。我们再把它返回的 JSON 换成跳转到 `/sign-in/two-factor`，带上 `next`。
- 会话的有效期和密码登录勾选"记住我"时相同。

### 首次登录（还没有绑定）

按顺序判断：

1. **第三方给的邮箱已经是某个账号的**：
   - 这个账号现在**没有任何能用的登录方式**（没有密码、没有通行密钥，也没有绑在启用中插件上的第三方账号），并且 `emailVerified` 是 `true`：直接绑定并登录，照常检查两步验证。这类账号的主人本来就只能靠邮箱找回密码；第三方确认过的邮箱，和收到找回密码邮件是同一个证据。从 BS 导入的、经第三方登录建的账号就是这样迁移过来的。
   - 其他情况一律不绑定，提示"这个邮箱已经注册过，先用原来的方式登录，再到「登录与安全」绑定"。原主人自己选的登录方式还在，悄悄多出一条由第三方声明决定的登录途径，等于把账号交给第三方的邮箱验证（Microsoft 工作账号的 `email` 就能被租户管理员随便填）。
2. **本站关闭了注册**（`auth.registration.enabled`）：提示暂停注册，不建号。已经绑定的用户照常登录。
3. **其余情况进入"完成注册"页**（`/sign-in/complete`）：
   - 第三方给的身份暂存在 `verifications` 里（30 分钟），同时写一个签名 Cookie。页面通过 `GET /api/auth/plugin-login/pending` 读出要预填的内容。
   - 表单：邮箱（预填第三方的，可以改；第三方没给就必须填）；昵称，或者 `auth.registration.withPlayerName` 打开时填角色名（第三方的名字能通过校验才预填）；插件加在 `auth.register` 上的字段。没有密码。
   - 提交到 `POST /api/auth/plugin-login/complete`，走**注册用例**。注册用例的密码改成二选一：密码，或者第三方身份。注册开关、邮箱格式和域名名单、同一 IP 的注册数、`user.register` 拦截器、插件字段、初始积分、同名角色、`user.registered` 事件都照常生效。同一个事务里写绑定，不写 `credential` 行。
   - 邮箱和第三方给的一致（转小写后比较）、并且 `emailVerified`，就标成已验证；否则照常发验证邮件（ADR-0018）。
   - 成功后删掉暂存的身份，签发会话。注册失败（例如邀请码不对）时暂存的身份还在，改了再提交。同一个身份并发提交，由唯一索引兜底，返回 `identity_already_bound`。PG 上唯一冲突会让整个事务作废，所以和 `email_taken` 一样，等事务失败后在事务外转换。
   - 总是显示这一页，不静默建号：邀请码、角色名这些字段要用户自己填，用户也能看到建的是什么账号。BS 的静默建号正是绕过注册开关和邀请码的地方。

### 绑定和解绑

在 `/user/security` 加"第三方账号"一块：列出能用的 Provider 和已有的绑定；插件停用了的绑定标"已停用"，也能解绑。

- **绑定要求刚登录过**：同 ADR-0023 的通行密钥，`freshAge` 10 分钟。偷到会话 Cookie 的人不能给账号加一个自己的第三方账号，之后改密码也赶不走他。
  - 回调时核对当前会话的用户就是发起绑定的那个人。
  - 这个第三方账号已经绑在别的用户上，返回 `identity_bound_elsewhere`，不说是哪个用户；这个用户在该 Provider 上已经有绑定，返回 `already_bound`。
  - 绑定成功后（包括首次登录第 1 步的直接绑定），配置了邮件时给账号邮箱发一封通知，写明绑了哪一家、什么时间，不带链接。账号被盗用时，原主人至少能知道。
- **解绑**：`DELETE /api/user/bindings/{插件 id}/{Provider id}`，由领域用例处理，不要求刚登录过。
  - 解绑之后要还有能用的登录方式：有密码，或者有通行密钥，或者有另一个绑在启用中插件上的第三方账号。否则返回 `last_login_method`。
  - 事务里先锁用户的行（`docs/schema.md` 的加锁顺序），两个解绑请求排队执行。删除通行密钥由 Better Auth 处理，不锁这一行，所以同时删掉最后一个通行密钥和最后一个绑定可能都成功。这条规则防的是误操作，不防这种并发；真碰上了，还能用找回密码。
- 绑定和解绑都不发事件：SDK 里没有对应的事件，也没有插件需要。不写审计日志：审计日志记的是管理操作（ADR-0027）。
- Better Auth 的 `/unlink-account`、`/list-accounts`、`/link-social`、`/sign-in/social`、`/callback/:id`、`/get-access-token`、`/refresh-token`、`/account-info` 加进 `disabledPaths`，由上面的端点代替。不关的话，`/unlink-account` 能删掉自己的密码，绕过"最后一种登录方式"的检查。

### 没有密码的账号

经第三方登录建的账号没有 `credential` 行。

- 安全页给它们"设置密码"，要求刚登录过，用 Better Auth 只能在服务端调用的 `setPassword`。设好之后，和改密码一样发 `user.profileUpdated`（`fields: ['password']`）。找回密码对它们同样有效。
- 要核对密码的操作（改邮箱、删除账号、开关两步验证）提示先设置密码，不另做一套不用密码的确认流程。
- 启动器登录（authserver）只认密码。仪表盘的外置登录配置里提示：先设置密码，才能在启动器里登录。

### 登录页

- 密码表单下面列出可用的第三方：插件已启用、设置通过 manifest 里 JSON Schema 的校验、host 加载了这一代。设置的校验在核心进程内完成，不发起跨进程调用。缺了客户端 ID 的插件不显示按钮，管理员只启用、不填设置，也不会出现点了就报错的按钮。
- 按钮用 Provider 声明的 pixelarticons 图标和文案。注册页也放同样的按钮，和 BS 相同。
- 熔断中或 host 不可用时，按钮照常显示，点击后提示暂时不可用。

### 不做

- **通用 OAuth2 / OIDC**（管理员自己填地址）：`network` 是 manifest 里写死的 origin，做不成插件。要做就进核心，或者以后给插件加"由设置决定出站 origin"的能力，另写 ADR。
- **导入 BS 的绑定**：BS 没有绑定，见"背景"。导入 BS `.env` 里的客户端 ID 和密钥也不做：那时插件还没有启用，凭据也最好由管理员在第三方的控制台重新核对回调地址时再填。迁移指南写明步骤。
- 后台替用户解绑：随"后台的其余管理操作"一起做（ADR-0027）。
- 同步第三方的昵称、头像，存第三方的令牌。
- `user.loggedIn` 事件：仍然推迟（ADR-0033）。

### 测试

- **四种数据库**（`*.db.test.ts`）：
  - 同一个第三方账号并发绑给两个用户，只有一个成功；同一用户并发绑同一个 Provider 的两个账号，只有一个成功；
  - "完成注册"被 `user.register` 拦截器拒绝时整体回滚，没有留下绑定；成功之后同一个暂存身份不能再用；
  - 解绑最后一种登录方式被拒绝；
  - 卸载插件删掉它名下的绑定；
  - 没有密码的账号找回密码之后能用密码登录。
- **请求级测试**，插件在两条加载路径上各跑一遍，核心给插件代发请求的 `fetch` 换成假的第三方：
  - 已绑定的登录；首次登录到完成注册；邮箱撞上已有账号的两种情况；
  - 开了两步验证的账号要过第二步，信任过的设备不用；
  - state 的 Cookie 对不上（换了浏览器）、过期，都被拒绝；`error=access_denied` 不调用插件；
  - 插件超时、抛错、返回非法 subject，都跳回登录页，日志里没有插件的消息。
- **e2e**（`oauth-github`，两条加载路径）：后台填设置、看到回调地址；登录页出现按钮；点击后拦下去 `github.com` 的跳转，核对 `client_id`、`redirect_uri`、`state`；带 `error=access_denied` 回到回调，登录页显示"已取消"。e2e 里 `ctx.fetch` 访问的是真的 `github.com`，换令牌的部分由上面的请求级测试覆盖。不为 e2e 在生产代码里加"把出站请求转到别处"的开关：它本身就是一个能把插件的请求导向任意地址的后门。
- **插件**：四个插件都用录下来的第三方响应做单元测试，覆盖字段映射和 `emailVerified` 的判断。
- **SDK**：type-tests 跟上 `ExternalIdentity` 的改动。

## 后果

- 新迁移：`accounts` 的两列改成 `authStringType`，建两个唯一索引。Better Auth 的 schema 比对测试照常要通过。`docs/schema.md` 的 `accounts` 补上绑定的格式，`users.image` 改成"不再写入"。
- `auth.ts`：新的 Better Auth 插件（发起、回调、暂存身份、完成注册）；`disabledPaths` 加上 Better Auth 自带的第三方登录和账号端点。
- 依赖两步验证插件 after 钩子的结构（`hooks.after[0].handler`，以及它返回的 `twoFactorRedirect`）。升级 Better Auth 时由上面"要过第二步"的测试守住，和 ADR-0007 对设备流内部结构的依赖一样处理。
- ADR-0023 列出的"真正签发会话的地方"多了两处：第三方登录的回调和"完成注册"。`user.loggedIn` 落地时要挂上。
- 注册用例的输入从"必须有密码"变成二选一，`POST /api/register` 不变。
- `packages/email` 加一个模板：绑定了第三方账号的通知。
- i18n：错误码 `external_login_cancelled`、`external_login_failed`、`external_login_unavailable`、`external_email_taken`、`identity_bound_elsewhere`、`identity_already_bound`、`already_bound`、`last_login_method`，以及"完成注册"页、安全页、插件详情页的文案。
- 从 BS 迁移过来、经第三方登录建的账号：用 GitHub、Google、LittleSkin 登录时按"首次登录"第 1 步直接绑定；原来用 Microsoft 登录的，Microsoft 报告未验证，只能找回密码。`packages/importer/MIGRATION.md` 补一节：在第三方的控制台把回调地址改成新站的、在后台启用插件并填凭据，以及哪些用户需要找回密码。导入报告里"密码哈希认不出"那一项的说明，补上"可以用第三方登录"。
- 按钮只能用 pixelarticons 的图标。Google 等对登录按钮的样式有品牌要求，插件的说明里写明；核心不为此开放插件自带图片。
- 首批四个插件放在 `plugins/*`，随站点发布。ADR-0033 的参考插件验收里，第三方登录一行改成 `oauth-github`。
- 采纳时：ADR-0010、ADR-0033 的状态注明"合并成一个第三方登录插件"一条被本 ADR 取代，ADR-0023 注明由本 ADR 补充；`docs/schema.md` 的 `accounts`、`users.image` 改成本 ADR 的写法。

## 考虑过的其他方案

- **合并成一个插件**（ADR-0010、0033 原来的写法，照 CDN 刷新的先例）：CDN 是几家里选一家，用一个单选的设置就够；登录是几家同时开，合并之后要给 SDK 加按设置决定 Provider 可不可用的声明，第一版就冻住。共用代码这个主要的好处，靠内部的 workspace 包同样能得到。
- **用 Better Auth 的 `socialProviders` / `genericOAuth`**：它在回调里自己建用户，不经过注册用例，邀请码和注册表单的插件字段都拦不住，正是 BS 的漏洞；令牌交换在核心里做，插件只能给配置，接不了 QQ、微信这种不标准的第三方；它还会存第三方的令牌。state 的工具函数照样借用。
- **按已验证的邮箱自动绑定已有账号**（Better Auth `accountLinking` 的默认，BS 更进一步不看验证）：把账号的安全交给每个第三方的邮箱验证和每个插件的正确性，原主人也察觉不到。只在账号已经没有任何登录方式时这样做，见"首次登录"。
- **邮箱撞上时，先登录原账号，登录后自动完成绑定**：要把待绑定的身份带过一次登录（还可能经过两步验证），多一份跨请求的状态。到安全页再绑一次，只多一次跳转。
- **首次登录静默建号**（BS 的做法）：邀请码、角色名没有地方填，用户也不知道建了什么账号。
- **首次登录必须设密码**：多一步，大多数只在网页上换皮肤的用户用不到密码。需要启动器登录时再提示设置。
- **第三方登录不要求两步验证**（Better Auth 自带第三方登录的行为）：见"登录"。
- **Microsoft 接工作和学校账号**（`common` 租户）：`email` 由租户管理员填写，曾经出过按邮箱冒认账号的漏洞（nOAuth）；Minecraft 玩家用的都是个人账号。
- **为 e2e 把插件的出站请求转到假服务器**：见"测试"。
