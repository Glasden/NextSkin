# ADR-0037 Yggdrasil Connect：开放 OIDC 授权服务器和设备授权，内置一个只走设备码的公用应用；OAuth 令牌沿用启动器令牌的有效期和数量上限；进服、`validate`、`invalidate`、启动器上传材质认带 Join 的 OAuth 令牌；改密码、作废在途的登录、转让和删除角色一并吊销 OAuth 令牌；用户自己管理 OAuth 应用

- 状态：已采纳（令牌端点签发带 Join 的令牌之后调用插件的拦截器，被拒绝时删掉令牌、返回 `invalid_grant`，由 ADR-0045 补充；停用、删除应用另发站内通知由 ADR-0052 补充；授权页的 `frame-ancestors 'none'` 扩到全站由 ADR-0053 补充）
- 日期：2026-10-20
- 补充 ADR-0007：落地 Connect 的端点、页面、声明和 scope 规则；scope 错误在能确认回调地址时重定向回去；设备流程的认领、批准和拒绝由领域用例完成，角色随批准一起写入；取代"创建 OAuth 客户端需要管理员会话"一句：用户在用户中心自己创建，Better Auth 管理客户端的端点全部关闭
- 补充 ADR-0018：开着 `auth.requireEmailVerification` 时，授权任何 OAuth 应用也要先验证邮箱，同启动器登录
- 补充 ADR-0022：删除角色时连带删掉绑定它的 OAuth 令牌和同意记录
- 补充 ADR-0023：用户改密码、重设密码时，和启动器令牌一起删掉全部 OAuth 令牌；安全页新增"已授权的应用"
- 补充 ADR-0027：新权限 `oauthClients.manage` 和三个审计动作；`auth.ts` 里创建 OAuth 客户端的 `isAdmin` 判断去掉
- 补充 ADR-0030：进服、`validate`、`invalidate`、启动器上传和删除材质多一个 OAuth 令牌的分支；`tokenValidSeconds`、`tokenRefreshableSeconds`、`tokensPerUser` 也作用于 OAuth 令牌；站点地址是 https 时，元数据加上 `feature.openid_configuration_url`
- 补充 ADR-0031：导入器把 Janus 标记的公共客户端转成公共客户端；整库替换时保留公用应用
- 补充 ADR-0036：作废在途的登录（后台改密码、收回账号、退出全部登录、命令行 `set-password`）一并删掉 OAuth 令牌和在途的设备码；转让角色删掉绑定这个角色的 OAuth 令牌和同意记录；用户详情页显示已授权的应用数

## 背景

### 规范

Yggdrasil Connect 是 authlib-injector issue #268 里的规范草案（tnqzh123），在 OIDC 上加了角色：

- 三个 scope：`Yggdrasil.PlayerProfiles.Select`（选一个角色，访问令牌绑定它，ID 令牌带 `selectedProfile`）、`Yggdrasil.PlayerProfiles.Read`（ID 令牌带 `availableProfiles`，全部角色）、`Yggdrasil.Server.Join`（能拿访问令牌进服）。
- 组合规则：申请任一 Yggdrasil scope 必须同时申请 `openid`，否则 `invalid_scope`；Select 和 Read 不能同时申请；申请 Join 必须同时申请 Select。没有 Join 的令牌，会话服务器必须拒绝。
- 角色的序列化是 `{ id: 无连字符的 UUID, name }`，不带属性。userinfo 是 ID 令牌声明的超集，不含 `iss`、`iat`、`exp`。
- 发现文档必须有 `issuer`、`token_endpoint`、`userinfo_endpoint`、`jwks_uri`、`scopes_supported`（至少 `openid`、Select、Join）、`subject_types_supported`、`id_token_signing_alg_values_supported`（含 RS256）；`authorization_endpoint` 和 `device_authorization_endpoint` 至少一个；可选的 `shared_client_id` 是"公用应用"的标识。启动器从 Yggdrasil 元数据的 `meta['feature.openid_configuration_url']` 找到发现文档。必须走 HTTPS。ID 令牌必须带 `kid`。
- 令牌：访问令牌对应用不透明；访问令牌和刷新令牌一对一，吊销访问令牌时它的刷新令牌也要吊销；刷新令牌只能用一次，刷新时吊销旧的访问令牌；只有申请了 `offline_access` 才发刷新令牌；ID 令牌的有效期"一般与访问令牌一致"；每个应用持有同一用户的有效访问令牌数量要有上限，超出时先吊销最早的。
- 公共客户端和公用应用"应"受限制：每次都征求同意（强制 `prompt=consent`）、缩短令牌有效期、禁止申请部分敏感的 scope；授权页标明是公用应用。公用应用"可以"用环回地址或任意 https 作回调。具体措施由服务器自定。

这个 issue 在 2025-01 关闭并锁定，2026-06 有人以"已经有皮肤站和启动器支持"为由建议重开。没有正式版本，下面说的"规范"都指这份草案，兼容性以启动器的实际请求为准。

### BS 生态的实现

BS 用插件 yggdrasil-connect（6.2.0，LittleSkin 出品）加外挂的 Janus（NestJS + panva/oidc-provider，只支持 MySQL）：

- 元数据：配置了 Janus 的地址才加 `feature.openid_configuration_url`。另有 `ygg_disable_authserver`，打开后去掉 `feature.non_email_login`。
- Janus 的令牌是 JWT，`aud` 是 client_id。访问令牌和 ID 令牌 3 天、刷新令牌 7 天、设备码 600 秒。每个用户在每个客户端上最多 `ygg_tokens_limit`（默认 5）个，超出吊销最旧的。刷新时手动吊销旧的访问令牌。要求邮箱已验证、没有被封禁。
- 公共客户端的标记：BS 的 OAuth 应用回调地址里加一条 `{site_url}/yggc/client/public`，这样的客户端认证方式是 `none`，授权码流程必须带 PKCE。`SHARED_CLIENT_ID` 写在 Janus 的 `.env` 里，"一般是个人访问应用的 ID"。
- 角色在 BS 的 `/yggc/callback` 上选，记在 `code_id_to_uuid` 表。
- 插件侧：`join` 接受 Janus 令牌，判断条件是有 Read 或 Select（没要求 Join，是缺陷）；`validate` 接受任意有效的 Janus 令牌，不看 clientToken；`invalidate` 吊销访问令牌和刷新令牌；`refresh` 拒绝 Janus 令牌；启动器上传材质接受 Janus 令牌，要求 `selectedProfile` 等于路径里的 UUID；改密码、改邮箱只吊销 authserver 的令牌。

### 启动器

| 启动器 | 流程 | client_id | 对服务器的要求 |
|---|---|---|---|
| PCL-CE | 只用设备码 | 按 host 写死的表（littleskin.cn → 1514），没有就用 `shared_client_id` | scope 是 `openid offline_access Yggdrasil.PlayerProfiles.Select Yggdrasil.Server.Join`；按公共客户端请求，不带密钥；首次登录和刷新都要返回 `id_token`，首次还要 `refresh_token`；按 `kid` 找密钥验签，校验 `aud` 等于 client_id；取不到 `selectedProfile` 就去 userinfo 取；用 userinfo 检查令牌是否有效 |
| SJMCL 及衍生版（USTBL、IMUCL、AHNUMCL、XMCL-Origin173） | 设备码 | 写死的 BS Passport id（skin.mc.sjtu.cn → "6"、littleskin.cn → "1014"、skin.mualliance.ltd → "27" 等），没有就用 `shared_client_id` | 同一组 scope；**只用 JWKS 的 `keys[0]` 验签，不看 `kid`**；校验 `aud`；刷新也要返回新的 `id_token` 和 `refresh_token` |
| XMCL | 设备码 | 注册表或 `shared_client_id` | |
| FluentCore | 设备码 | 必须有 `shared_client_id` | 从 userinfo 的 `selectedProfile` 取角色；刷新请求漏了 client_id（它自己的缺陷） |

HMCL 看起来不支持 Connect。Meloong-Git/PCL #5132 用的是 LittleSkin 自己的 `Yggdrasil.MinecraftToken.Create`，不在规范里。没有启动器用授权码流程：Connect 对启动器来说就是设备码流程，授权码流程服务的是第三方网站。

### 现状

- `@better-auth/oauth-provider` 和 `oauthDeviceAuthorization` 已经接进 Better Auth 的配置（`auth/auth.ts`）：RS256 的 ID 令牌、sha256 存令牌和客户端密钥、关掉 DPoP、只接受 `none`、`client_secret_basic`、`client_secret_post`（`serial-safety.ts`）。`OAUTH_SCOPES` 只有 `openid profile email offline_access`。`loginPage` 是 `/sign-in`，`consentPage` 是 `/oauth/consent`，设备的 `verificationUri` 是 `/device`，后两个页面都不存在。
- `auth/service.ts` 把 `/api/auth/*` 整个交给 Better Auth，发现文档由它按 OIDC 的位置手动提供，所以 OAuth 端点其实已经能访问。创建客户端的端点要求管理员（`clientPrivileges`），但没有界面；从 BS 导入的站点上已经有 OAuth 应用，它们的授权请求会跳到不存在的同意页。
- 表都在：`oauth_clients`、`oauth_access_tokens`、`oauth_refresh_tokens`、`oauth_consents`（三张都有 `reference_id`）、`device_codes`、`device_code_selections`（ADR-0007、S1）。
- 进服只认 `yggdrasil_tokens`（ADR-0030 说 Connect 落地时"多一个分支，按 OAuth 访问令牌的哈希查表"）。元数据没有 `feature.openid_configuration_url`。作废在途的登录（`auth/revoke.ts`）和改密码之后的回调都不碰 OAuth 令牌。
- 导入器把 BS 的 Passport 客户端原样导入：client_id 转成字符串，有密钥的是 `client_secret_basic`，没有的是 `none` 加 PKCE，授权方式都是授权码和刷新。不认 Janus 的公共客户端标记。
- S1 验证过 Connect 的全部必选能力，结论写在 ADR-0007。留给实现阶段的：scope 错误按 RFC 6749 重定向回去；authserver 和 OAuth 令牌是否统一（ADR-0030 定了不合并）。S1 的胶水代码修复后没有再做独立复审。

Better Auth 1.7.10 里和这里相关的行为：

- issuer 是 `jwt.issuer ?? baseURL`，也就是 `https://站点/api/auth`；`jwks_uri` 是它加 `/jwks`。
- 默认有效期：访问令牌 1 小时、ID 令牌 10 小时、刷新令牌 30 天、授权码 10 分钟、设备码 30 分钟（轮询间隔 5 秒）。这些选项在创建实例时固定，`scopeExpirations` 只能缩短。
- 刷新时，有效的 scope 里有 `openid` 就重新签 ID 令牌。旧刷新令牌用带条件的更新标记为已吊销，并且保留；**旧的访问令牌不吊销**。再拿已吊销的刷新令牌来刷新，按重放处理，作废这个用户在这个客户端上的整组刷新令牌。
- 只有请求带 `resource` 时才签 JWT 访问令牌，否则是不透明令牌。
- 发现文档的 `token_endpoint_auth_methods_supported` 只有打开动态注册或配了 `clientDiscoveries` 时才列出 `none`。
- 设备授权：`/device/code` 校验客户端，接受一个 `user_id` 参数（预先绑定用户）；`GET /device?user_code=` 不要求登录，登录时把待批准的码认领给当前用户；`/device/approve` 要求登录、待批准、认领者是本人。OAuth 设备码只能在 `/oauth2/token` 兑换，插件自带的 `/device/token`（签发网页会话）会拒绝它。兑换时调用 `issueTokens` 不传 `referenceId`，S1 包装 `oauthDeviceAuthorization().options.grant.grants` 绕过，这个结构在 1.7.10 仍然存在。
- 网页会话被删除时（退出登录），吊销这个会话里签发的访问令牌，以及其中不带 `offline_access` 的刷新令牌。
- 停用的客户端（`disabled`）在授权、换令牌、introspection、userinfo 上都被拒绝。客户端只有登记了 `authorization_code` 时才要求回调地址；只有设备码和刷新的客户端是允许的。

其他 ADR 留下的问题：

- ADR-0036："OAuth 的令牌和用户自己改密码时一样不动，等 Yggdrasil Connect 的切片一起定"；"Connect 的 ADR 要决定收回账号、退出全部登录是否一并吊销它们"；转让角色时"Yggdrasil Connect 记在 `oauth_consents` 里的角色，等 Connect 的切片处理"。
- ADR-0022：删除角色时，"Connect 记在 `oauth_consents.reference_id` 里的角色，在各自的切片落地时处理"。
- ADR-0018：开着验证邮箱要求时，OAuth 应用管理要先验证邮箱。ADR-0023：删除账号时一并删除名下的 OAuth 应用（外键级联）。

## 决定

### 范围

这次做：

- 授权服务器：发现文档、JWKS、授权码流程（带 PKCE）、设备码流程（RFC 8628）、刷新、userinfo、吊销、introspection；
- Connect 的三个 scope、组合规则、声明和角色绑定；
- 页面：`/device`（设备码流程的批准页）、`/oauth/consent`（授权码流程的同意页），登录完成后回到授权流程；
- 内置的公用应用，发现文档里给出 `shared_client_id`；
- Yggdrasil 元数据里的 `feature.openid_configuration_url`；
- 进服、`validate`、`invalidate`、启动器上传和删除材质认 OAuth 令牌；
- 令牌的有效期、数量上限，刷新时吊销旧的访问令牌；
- 吊销规则：改密码、作废在途的登录、转让和删除角色、取消授权；
- 用户中心的"OAuth 应用"页、安全页的"已授权的应用"、后台的"OAuth 应用"页，权限 `oauthClients.manage` 和审计；
- 导入器认出 Janus 的公共客户端标记。

不做，留给以后：

- 第三方用 OAuth 令牌调用 REST 接口（ADR-0022，等设计 API scope）；
- 动态客户端注册、pairwise 的 `sub`、浏览器里运行的应用（CORS）、JWT 访问令牌和 `resource`；
- 签名密钥轮换。以后做的话，JWKS 里正在用的那把密钥要排在第一个（SJMCL 只用 `keys[0]`）；
- 关掉 authserver 的开关（BS 的 `ygg_disable_authserver`）：HMCL 不支持 Connect；
- RP 发起的退出（`end-session`）和 back-channel logout；
- 刷新令牌的重放宽限（`refreshTokenReuseInterval`），保持 0；
- 应用的图标、主页、隐私政策等元数据（BS 没有），免同意的第一方应用（`skip_consent`）；
- LittleSkin 的 `Yggdrasil.MinecraftToken.Create`；
- 角色改名后令牌失效（yggdrasil-connect 的做法），见"考虑过的其他方案"；
- 后台逐条查看、吊销某个用户的已授权应用（这次只显示数量，"退出全部登录"一并吊销，同 ADR-0036 对启动器令牌的处理）。

### 分三个切片落地

每个切片一个提交，各自更新 `PROGRESS.md`：

1. **设备码流程**：scope 规则、声明、发现文档、元数据字段、公用应用、`/device` 页、进服和 authserver 的分支、启动器上传材质、有效期和上限、吊销规则、导入器、安全页的"已授权的应用"。这一步之后，启动器能用公用应用和导入的公共客户端登录。
2. **授权码流程**：`/oauth/consent` 页、登录后续跑、scope 错误的重定向。
3. **应用管理**：用户中心的"OAuth 应用"页、后台的"OAuth 应用"页、权限和审计。在这之前，只有导入的应用和公用应用。

切片一里还没有同意页，选不了角色：授权码流程申请 Yggdrasil scope 时返回 `invalid_scope`；不带 `scope` 时按应用登记的 scope（没登记时是全部）补上，去掉其中的 Yggdrasil scope。授权码流程的端点在切片一已经开着，直接调用也能走通，所以"授权的前提""每次都征求同意"、不接受部分 scope、换授权码时检查会话，都在切片一生效；只是公共客户端带 `prompt=none` 时的 `consent_required` 先以 JSON 返回，切片二随 scope 错误一起改成重定向回去。注册页传递 `next`（见"登录后续跑"）在切片一就做：`/device` 没登录时也要经过登录或注册再回来。

切片二放开授权码流程里的 Yggdrasil scope，加上同意页、站内错误页 `/oauth/error` 和登录后续跑；scope 错误、`consent_required` 改成按可信的回调地址重定向回去；被封禁、邮箱没验证的用户带着会话打开授权地址时，送到同意页说明原因，不再返回 JSON 403；`/oauth2/continue` 关掉。

切片三只加应用的管理：两个应用页、用户详情页的两个数、权限和审计。不改 Better Auth 的配置和钩子，不加迁移，不动协议、SDK 和导入器：新建的应用写的列和导入的应用是同一套，授权流程照旧。

### 端点

都在 `/api/auth` 下，由 Better Auth 处理，经过现有的客户端认证改写（`client-authentication.ts`）和 serial 下的能力限制：

| 端点 | 用途 |
|---|---|
| `GET /.well-known/openid-configuration` | 发现文档，`service.ts` 手动提供，见"发现文档" |
| `GET /jwks` | 签名公钥 |
| `GET`、`POST /oauth2/authorize` | 授权码流程的入口 |
| `POST /oauth2/consent` | 同意页提交 |
| `POST /oauth2/token` | 授权码、刷新、设备码三种授权方式 |
| `GET`、`POST /oauth2/userinfo` | |
| `POST /oauth2/revoke`、`POST /oauth2/introspect` | RFC 7009、RFC 7662，要求客户端认证 |
| `POST /device/code` | 设备授权请求 |

只开这八组。oauth-provider 和设备授权插件的其余端点放进 `disabledPaths`：`/oauth2/continue`、`/oauth2/register`、`/oauth2/create-client`、`/admin/oauth2/create-client`、`/oauth2/update-client`、`/admin/oauth2/update-client`、`/oauth2/delete-client`、`/oauth2/get-client`、`/oauth2/get-clients`、`/oauth2/client/rotate-secret`、`/oauth2/client/rotate-keys`、`/oauth2/public-client`、`/oauth2/public-client-prelogin`、`/oauth2/get-consent`、`/oauth2/get-consents`、`/oauth2/update-consent`、`/oauth2/delete-consent`、`/oauth2/end-session` 及其确认页、`/.well-known/oauth-authorization-server`（发现文档只按 OIDC 的位置提供），以及设备授权插件的 `/device/token`、`/device`、`/device/approve`、`/device/deny`。资源管理的端点只能在服务端调用。`connect.db.test.ts` 逐个请求这两个插件的全部端点，不在上表里的必须是 404，升级 Better Auth 多出端点时测试会失败。

- 客户端的增删改要求邮箱验证、写审计、生成只显示一次的密钥，取消授权要连同令牌一起删，这些都由领域用例和 REST 完成（不变量 4），同 ADR-0034 关掉账号端点的理由。同意页和批准页在服务端经领域查询取应用信息，用不到 `public-client`。
- `/device/token` 现在会拒绝 OAuth 设备码，关掉是多一道保险：它签发的是网页会话，哪天它的判断变了，设备码钓鱼就能拿到整个账号。
- `GET /device`（认领）、`/device/approve`、`/device/deny` 关掉，批准页的认领、批准、拒绝改由领域用例和 REST 完成（见"页面"）：Better Auth 1.7.10 的批准和拒绝按 id 无条件更新状态，没有"还在待批准、由认领者处理"的守卫，角色选择也没法和批准写进同一个事务。
- `/device/code` 不接受 `user_id`，返回 `invalid_request`：设备码只能由打开批准页的人认领。
- `/oauth2/continue` 关掉（切片二）：登录后续跑改成重新打开授权地址（见"登录后续跑"），用不上它；它是一个"带着会话、按签名参数接着跑 authorize"的通用入口，处理不了 `prompt=login`，还能绕开同意请求走到 `consentReferenceId`。
- Content-Type 含 `application/x-www-form-urlencoded`、主类型却不是它时，返回 `invalid_request`：better-call 按主类型解析请求体，设备授权端点却在 Content-Type"包含"它时把原始请求体按表单重读，两边读到的参数不同，钩子对 `resource`、`user_id` 的检查会落空。这条检查在 Better Auth 的所有路径上做，不按路径区分：路由忽略末尾的斜杠，`/device/code/` 也会进设备授权端点。
- 请求体是 JSON、却不是对象（字符串、数组、`null`）时，返回 `invalid_request`。钩子早于端点的 schema 校验，按对象读这类请求体会抛出带着请求体原文的异常，原文可能是令牌，会进日志（不变量 11）。钩子判断 `grant_type` 前和端点一样去掉两端空白。
- `clientPrivileges` 和 `resourcePrivileges` 改成恒为 `false`（不写的话 Better Auth 放行任何登录的用户），`auth.ts` 的 `isAdmin` 随之去掉（ADR-0027 列出的"领域层对管理员的判断"少了一处）。客户端和资源只经领域用例管理。

### scope

`OAUTH_SCOPES` 加上三个 Yggdrasil scope，变成 `openid profile email offline_access Yggdrasil.PlayerProfiles.Select Yggdrasil.PlayerProfiles.Read Yggdrasil.Server.Join`。

组合规则照 ADR-0007，在每个入口检查：authorize（查询参数和表单请求体）、`/device/code`、刷新时的 `scope` 参数、同意和批准时最终接受的 scope：

- 有任一 Yggdrasil scope 就必须有 `openid`；
- Select 和 Read 不能同时申请；
- 有 Join 就必须有 Select；
- 公用应用只能申请 `openid`、`profile`、`offline_access` 和三个 Yggdrasil scope，不能申请 `email`（规范建议限制公用应用申请敏感的 scope）。

不满足时返回 `invalid_scope`。没有 Yggdrasil scope 的请求按普通的 OAuth/OIDC 处理，`openid` 不是必需的。

授权码流程不带 `scope` 时，按应用登记的 scope（没登记时是全部）补上，去掉其中的 Yggdrasil scope：全部 scope 里 Select 和 Read 互斥，补全了反而不合法；启动器都显式申请 Yggdrasil scope。

**不支持只同意一部分 scope**：同意页和批准页只有"同意"和"拒绝"，最终接受的 scope 必须等于申请的。S1 审核发现 2 就出在部分同意上；启动器也不处理拿到的 scope 比申请的少的情况。

**scope 错误的重定向**（ADR-0007 留到实现阶段的）：授权码流程里，`client_id` 逐字对应一个没停用、允许授权码的应用，`redirect_uri` 按 Better Auth 的规则匹配登记的某一条（逐字相同；http 的环回地址允许端口不同，RFC 8252）时，按 RFC 6749 §4.1.2.1 重定向回去，带 `error=invalid_scope`、原样的 `state`（空的不带）和 `iss`，参数放在查询串里；否则显示站内的错误页，不重定向（不能把用户送到没登记过的地址）。设备码流程和令牌端点返回 JSON 400。

- 钩子里的其他授权错误按同一条规则处理：`consent_required`、被封禁或邮箱没验证时带 `prompt=none` 的 `access_denied`、`prompt` 重复或带 `dpop_jkt` 的 `invalid_request`。`resource` 照旧返回 JSON `invalid_target`。
- 规则写"按 Better Auth 的规则"而不是"逐字相同"：启动器用环回地址加随机端口回调，Better Auth 自己的错误（PKCE、`claims` 等）照样会重定向回去，两边要一致。
- 查到了应用、`client_id` 却不逐字相同（MySQL 的排序规则忽略末尾空格）时，按应用不存在处理，显示站内错误页：Better Auth 查客户端时不逐字核对，这样的请求在它那里能走通，却会被钩子当成"没有这个应用"，跳过强制同意。
- 站内错误页是 `/oauth/error`，设成 Better Auth 的 `onAPIError.errorURL`，它自己的"应用不存在、已停用、回调地址没登记"等错误也去这里。不设的话，生产环境里这些错误落到站点首页 `/?error=…`，页面上什么提示都没有。错误页按 `error` 显示一句说明，不显示 `error_description`：那是请求方能左右的英文原文。
- `prompt=create`、`prompt=select_account` 当成 `login`：没有单独的注册入口和选账号页，登录页上能去注册、能换一个账号登录。Better Auth 对前者会在登录后续跑时又送回登录页，对后者直接报错。
- 带 `dpop_jkt` 的请求返回 `invalid_request`：授权码会绑定 DPoP，而我们不接受 DPoP（ADR-0015），这个码永远换不出令牌。
- 带 OIDC 的 `claims` 参数时返回 `invalid_request`，发现文档的 `claims_parameter_supported` 改成 `false`：Better Auth 按 `claims` 单独给出邮箱、昵称这些声明，不看 scope，只申请 `openid` 的应用也能拿到，同意页上却只按 scope 列权限（切片二审核发现）。
- `prompt` 按 Better Auth 的规则拆分（按空格拆、去掉每一项两端的空白）：`login` 后面跟一个制表符时，Better Auth 认得、钩子和登录页不认得，会在登录页和授权地址之间来回跳。

### 声明

| scope | ID 令牌和 userinfo 里的声明 |
|---|---|
| `openid` | `sub`：uid 的字符串。`subject_types_supported` 只有 `public` |
| `profile` | `name`：昵称；`picture`：头像的出图地址（`/render/v{N}/head/{s}/{hash}.png`，按材质原本的分辨率：出图只缩小不放大），没设头像时没有这一项 |
| `email` | `email`、`email_verified` |
| Select | `selectedProfile`：`{ id, name }`，`id` 是角色的 UUID（`players.uuid`，无连字符） |
| Read | `availableProfiles`：用户的全部角色，格式同上，按 `id` 排序，同 authserver 的 `availableProfiles`（ADR-0030） |

- userinfo 另外带 `aud`（规范的示例里有），不带 `iss`、`iat`、`exp`。userinfo 每次按现在的数据生成：角色改了名，userinfo 是新名字，ID 令牌里是签发时的名字。
- ID 令牌用 jwt 插件的 RS256 密钥签名，头部有 `kid`。JWKS 里现在只有这一把，不轮换。
- 访问令牌是不透明的（不登记 resource，请求带 `resource` 时返回 `invalid_target`）。

### 角色绑定

照 ADR-0007 和 S1：所选角色编码成 `reference_id = player:<pid>`，存在同意记录、访问令牌和刷新令牌上，刷新时沿用。

- **授权码流程**：申请 Select 时同意页上选角色，同意请求在请求头 `X-NextSkin-Player` 里带上 pid。consent 的 before 钩子在同一个请求里校验最终接受的 scope（组合规则、和申请的相等）、应用逐字存在且没停用、角色属于当前用户，再经请求级的状态把角色交给 `postLogin.consentReferenceId`（它的参数里没有请求头）。不把选择存进会话：同一用户并行的两个授权流程会串用（S1 审核发现 1）。
  - `consentReferenceId` 在申请了 Select、请求里却没有选好的角色时抛 `invalid_request`（Better Auth 的注释要求由它报错），不签出不带角色的授权码。
  - `postLogin` 只为了 `consentReferenceId` 才配置：`shouldRedirect` 恒为 `false`，没有选组织之类的额外步骤。
  - 同意记录按（应用、用户、角色）分开：换一个角色同意是新的一条，同一个角色再同意时更新原来那条。
- **设备码流程**：批准页上选角色，**选好的 pid 随批准请求一起提交**（`POST /api/user/device/approve`，请求体 `{ userCode, pid }`）。领域用例在一个事务里：锁住用户行，检查设备码待批准、认领者是当前用户、角色属于当前用户，带着这些条件把状态改成 `approved`，再写进 `device_code_selections`（按 `device_code` 字符串，ADR-0007）。兑换时包装内置的设备码授权，读出选择、补上 `referenceId`，不论签发成功与否都删掉这一行；被拒绝时也删掉。S1 的选择是单独一个请求，合进批准请求以后，选择和批准之间没有可以插进来的窗口，也少一个端点；ADR-0007 的约束（只在待批准状态、由认领者选择）照样成立。
- 申请 Select 时必须选角色：用户没有角色时不能同意，页面链接到用户中心的角色页；只有一个角色时默认选中，仍要用户点同意。
- 没有 Select 的授权不绑定角色，`reference_id` 为空。

### 每次都征求同意

申请 Select 时，或者客户端是公共客户端（认证方式是 `none`，包括公用应用）时，外部发起的每次授权都强制 `prompt=consent`；客户端带 `prompt=none` 时，有会话就返回 `consent_required`（ADR-0007），没有会话时由 Better Auth 返回 `login_required`。设备码流程本来就每次都要在批准页上确认。其他情况沿用 Better Auth 的行为：同意过的机密客户端，scope 没有变多就不再询问。

### 授权的前提

同意、批准都要求：

- 已经登录；
- 没有被封禁；
- 开着 `auth.requireEmailVerification` 时邮箱已经验证（补充 ADR-0018）。范围是全部 OAuth 应用，不只 Connect：启动器登录就有同样的要求（ADR-0030），给第三方网站的 `email` 也该是核实过的。

检查的地方和时机：

- 同意（`/oauth2/consent`）、带着会话的 `/oauth2/authorize`（同意过的机密客户端不经过同意页就发码）和批准页都检查。拒绝不要求这些。
- 带着会话的 `/oauth2/authorize` 不满足时（切片二）：加上 `prompt=consent`，送到同意页；同意页说明原因（封禁，或者先去验证邮箱），只给"拒绝"，拒绝后带 `access_denied` 回到应用。直接返回错误的话，用户看不到原因，应用那边也收不到结果。带 `prompt=none` 时按"scope 错误的重定向"的规则返回 `access_denied`。同意请求本身照旧返回 JSON 403，页面上不会发出这种请求。
- 刷新令牌、换授权码、兑换设备码、调用 userinfo 时同样检查封禁：被封禁的用户的令牌照样留着、解封后能用，同 authserver（ADR-0030）。令牌端点签发之后，在锁住用户行时再查一次（见"吊销"的签发途中一条）。userinfo 按 Better Auth 同样的顺序取令牌：先用 `parseAccessTokenAuthorization` 解析请求头，解析不出时用请求体，写法不同不能绕过检查。
- 邮箱验证只在同意、批准时要求，刷新、兑换和使用令牌时不再复查，同 authserver 令牌（ADR-0030）。

### 公用应用

- 一行固定的 `oauth_clients`：client_id 是 `shared`，名称由界面按语言显示（"{站点名} 公用应用"），没有主人（`user_id` 为空）、没有密钥、认证方式 `none`，授权方式**只有设备码和刷新**，没有回调地址。由迁移插入。
- 发现文档在它没停用时给出 `shared_client_id`。停用和启用在后台的"OAuth 应用"页上操作，用 `disabled` 列，Better Auth 在各个端点上都会拒绝停用的客户端，已签发的令牌随之失效；不另设设置项。不能删除。
- 只走设备码：规范允许公用应用用任意 https 回调，那样任何网站都能以"公用应用"的名义拿到能进服的令牌，同意页上也说不清是谁在请求。所有已知的启动器都用设备码流程。
- 批准页上标明这是公用应用：任何程序都能以它的名义发起请求，只在你自己刚刚在启动器里发起登录时继续。
- 公用应用和其他公共客户端的令牌有效期和机密客户端相同，不缩短，见"令牌"。

### 发现文档

在 Better Auth 生成的文档上（`service.ts`，照旧经过 `withoutSerialUnsafeMetadata`）：

- `token_endpoint_auth_methods_supported` 补上 `none`；
- `scopes_supported` 是上面七个 scope，`claims_supported` 补上 `selectedProfile`、`availableProfiles`；
- `grant_types_supported` 有授权码、刷新和设备码，`device_authorization_endpoint` 是 `https://站点/api/auth/device/code`；
- 去掉关掉的端点（`registration_endpoint`、`end_session_endpoint` 等）；
- 公用应用没停用时加上 `shared_client_id`。

缓存头沿用现在的 `max-age=15`：停用公用应用以后，最多 15 秒内还有启动器拿到它的 id。

### Yggdrasil 元数据

issuer 是 https 时（也就是站点地址是 https），`meta` 加上 `feature.openid_configuration_url: "https://站点/api/auth/.well-known/openid-configuration"`；是 http 时不加。

- 规范要求 HTTPS，http 站点上启动器会在明文连接上传令牌。
- 契约测试和 e2e 都跑在 http 上，`ygg/meta` 用例按深比较，不受影响；BS 的录制环境没有配置 Janus，本来也没有这个字段。
- 公用应用停用时照样给出：用自己 client_id 的启动器仍然能用。

### 令牌

- **有效期**：访问令牌和 ID 令牌用 `yggdrasil.tokenValidSeconds`（默认 3 天），刷新令牌用 `yggdrasil.tokenRefreshableSeconds`（默认 7 天，短于有效期时按有效期，同 ADR-0030），作用于全部 OAuth 应用。这两个值加进 Better Auth 实例的缓存键（`service.ts`），改了设置就换一个实例，之后签发的令牌按新值；已经签发的不变，同 ADR-0030。
  - Minecraft 客户端在启动时拿到访问令牌，之后每次进服都用它，一局游戏可以玩好几个小时，中途不会刷新。Better Auth 默认的 1 小时，开局一小时后就进不了服。authserver 的令牌、Janus 的令牌都是 3 天。
  - 授权码 10 分钟（默认）；设备码 10 分钟、轮询间隔 5 秒，同 Janus 的 600 秒。
- **数量上限**：每个用户在每个应用上最多保留 `yggdrasil.tokensPerUser`（默认 10）个访问令牌。签发之后（授权码、设备码、刷新三种都算），按签发时间倒序保留前 N 个，其余连同它们的刷新令牌删掉。两个请求同时签发可能短暂多出一个，下一次签发时裁掉，同 ADR-0030。BS 导入的 `ygg_tokens_limit` 就是 Janus 按应用计数用的那个值。
- **刷新**：刷新成功后，删掉旧刷新令牌关联的访问令牌（规范要求，Better Auth 不做）。旧刷新令牌的行照 Better Auth 的方式保留，靠它发现重放，`core:auth-cleanup` 在过期之后删除（ADR-0029）。带 `scope` 刷新时必须留着 `offline_access`，否则 `invalid_scope`：Better Auth 只在 scope 含它时轮换刷新令牌，去掉之后拿到的刷新令牌不再轮换、可以无限重放。
- 吊销访问令牌时，它的刷新令牌一起吊销（规范要求一对一）。Better Auth 的 `/oauth2/revoke` 只标记传进来的那一个时，由钩子补上另一个；钩子按 Better Auth 同样的方式规范化 `token` 参数（`stripAccessTokenAuthorizationScheme`：去掉空白和 `Bearer `），否则两边找到的不是同一个令牌。
- 我们自己的吊销一律删除行；Better Auth 自己的吊销是标记 `revoked`。下面的校验两种都认。

### 进服和 authserver

先按哈希查 `yggdrasil_tokens`，查不到再按同一个哈希查 `oauth_access_tokens`（两边都是 sha256 的 base64url，ADR-0030）。authserver 令牌的行为一点不变。

OAuth 令牌**能进服**要同时满足：

- 没有被吊销、没有过期；
- scope 里有 Join；
- 绑定了角色，角色此刻仍属于令牌的用户；
- 应用没有停用；
- 用户没有被封禁。

| 端点 | OAuth 令牌的处理 |
|---|---|
| `join` | 能进服，并且绑定的角色的 UUID 等于 `selectedProfile`；之后同 ADR-0030 |
| `validate` | 能进服就 204，不看 clientToken |
| `invalidate` | 删掉这个访问令牌和它的刷新令牌，204 |
| `refresh` | 403，和令牌不存在相同 |
| `signout` | 不变，只删 authserver 的令牌 |
| 上传、删除材质 | 能进服，否则 401（和无效的 authserver 令牌相同）；绑定的角色不是路径里的角色时 403 `ForbiddenOperationException`（`profile_mismatch`），排在"不是自己的角色"之后；之后同 ADR-0030（上传用例照样检查封禁、邮箱验证和积分） |

- 不满足条件时的响应和无效的 authserver 令牌完全相同，不透露令牌是哪一种、差在哪一条。封禁例外：同 authserver 令牌的用户被封禁时，返回 `user_banned`（上传、删除材质时是上传用例的 403），也看不出令牌是哪一种。
- `validate`、`invalidate` 认 OAuth 令牌，同 yggdrasil-connect：启动器里的通用 Yggdrasil 代码会在启动前 `validate`、退出时 `invalidate`。`validate` 要求"能进服"而不是"有效"：说令牌有效、进服却被拒，比直接说无效更难排查。
- 上传材质要求 Join，不只是绑定了角色：只申请 Select 的网站拿 Select 来认出玩家是谁，不该因此能改他的皮肤。同意页上 Join 的说明写成"以所选角色进入多人游戏服务器，在启动器里更换它的皮肤和披风"。
- `refresh` 不认：authserver 的刷新要沿用 clientToken、按 `selectedProfile` 绑定角色，OAuth 令牌没有这些；启动器刷新 OAuth 令牌走令牌端点。

### 吊销

| 发生什么 | OAuth 令牌 | 其他 |
|---|---|---|
| 用户改密码、重设密码（Better Auth 的路径） | 删掉这个用户的全部访问令牌和刷新令牌，和启动器令牌在同一个事务里（`onPasswordChanged`），事务先锁用户行，和批准设备码串行 | 删掉这个用户认领了的、还没兑换的设备码和 `device_code_selections`：盗号的人在改密码之前批准的设备码，不能在之后的 10 分钟里照样换出令牌；同意记录保留 |
| 作废在途的登录（`revokeLogins`：后台改密码、收回账号、删通行密钥、解绑、退出全部登录、命令行 `set-password`） | 同上，在调用方的事务里 | 删掉这个用户认领了的、还没兑换的设备码（待批准和已批准的）和 `device_code_selections`；同意记录保留 |
| 角色转让、删除 | 删掉 `reference_id = player:<pid>` 的访问令牌和刷新令牌 | 删掉同样 `reference_id` 的同意记录；`device_code_selections` 已经处理（ADR-0036、外键） |
| 用户在安全页取消对某个应用的授权 | 删掉这个用户在这个应用上的全部令牌 | 删掉同意记录、这个用户在这个应用上还没兑换的设备码 |
| 停用应用 | 不删，各个端点和进服校验都拒绝；启用后没过期的照样能用 | |
| 删除应用、删除用户 | 外键级联 | |
| 封禁 | 不删，每次使用时检查（同 ADR-0030） | |
| 网页上退出登录 | Better Auth 自己的行为：吊销这个会话里签发的访问令牌，以及其中不带 `offline_access` 的刷新令牌（只有授权码流程的令牌带会话） | |

- 回答 ADR-0036 留下的问题：改密码和作废在途的登录都吊销 OAuth 令牌。改密码删掉启动器令牌，是因为账号可能失控（ADR-0030）；OAuth 令牌留着的话，盗号的人在这之前用设备码授权一个启动器，就留下了进服的能力，等于绕过了改密码。
- 授权码 10 分钟有效，存在 `verifications` 里，值是 JSON，标识是授权码的哈希，按用户删不了。所以换授权码时检查发起授权的网页会话还在；作废在途的登录删掉了会话，这些授权码随之失效。
- 同意记录不删：它只记"同意过哪些 scope"，没有会话就用不上；绑定角色的同意记录随角色一起删。
- **签发途中的吊销**：令牌端点上 Better Auth 先消费设备码、授权码或旧刷新令牌，再插入新令牌，两步不在一个事务里。吊销恰好在两步之间提交时，删不到之后插入的令牌。所以每次删这个用户的 OAuth 令牌（上表的改密码、作废在途的登录、取消授权）都把 `users.oauth_version` 加一；令牌端点开始时按授权码、设备码或刷新令牌找出用户、记下版本，签发之后锁住用户行再核对：版本变了、用户被封禁了，就撤回刚签发的令牌，返回 `invalid_grant`。同 authserver 签发时钉住密码哈希（ADR-0030）。这一步失败时返回 `server_error`，不把令牌发出去。只吊销一个令牌（`/oauth2/revoke`、`invalidate`）不加版本：和它并发的刷新等同于先刷新、再吊销旧令牌，按这个顺序新令牌本来就留着。

### 页面

照 DESIGN.md，组件先在 `packages/ui` 里找。两个授权页面都加 `X-Frame-Options: DENY` 和 `frame-ancestors 'none'`，防点击劫持（全站的 CSP 还没做）。

**`/device`**（设备码流程）：

- 带 `?user_code=` 时直接进入确认；没有就先输入用户代码，按 Better Auth 相同的规则规范化（大小写、连字符，S1 审核发现 6）。没登录时去 `/sign-in?next=…`，登录后回来；从登录页去注册的也带着 `next`。
- 服务端渲染页面时调用领域用例认领（打开就认领，ADR-0007）：只认领待批准、还没人认领的设备码。批准、拒绝走 REST（`POST /api/user/device/approve`、`/deny`），领域用例带着"待批准、认领者是自己"的条件更新状态，并发的两次处理只有一次成功；拒绝不要求没被封禁、邮箱已验证。处理完就地显示结果，不刷新页面：启动器几秒内就来兑换，设备码随之删掉，刷新会显示成"代码不存在"。
- 确认时显示：应用名称；创建者的昵称（"由 {昵称} 创建"），公用应用改成上面的说明；申请的权限，按 scope 写成人话；申请 Select 时的角色选择；一行警告："只有在你自己刚刚在启动器或设备上发起登录时才继续。别人发给你的代码，不要输入。"
- 同意、拒绝之后显示结果，告诉用户回到启动器。代码过期、已经用过、被别人认领了，各有一句说明。
- 限流：`/device/code` 按 IP（Better Auth 的 `customRules`，60 秒 30 次；令牌端点 60 秒 300 次）。批准页按用户限制**猜错代码**的次数：认领、批准、拒绝时查不到代码都计一次，10 分钟内满 10 次就返回 `too_many_requests`，计数在进程内存里（Better Auth 的 `customRules` 只能按 IP）。用户代码是 8 位、32 个字符（Better Auth 默认），配合这个限制猜不中。

**`/oauth/consent`**（授权码流程）：显示应用名称、创建者、回调地址的主机名、申请的权限和角色选择，"同意"和"拒绝"。拒绝时 Better Auth 带着 `access_denied` 重定向回去。

- 服务端渲染时先验签名（`verifyOAuthQueryParams`，用 Better Auth 实例的 secret）：伪造的地址能把任意应用名和回调主机显示在本站页面上，提交时才会被拒绝。签名不对、过期、应用不存在或停用、回调地址没登记时，显示"授权请求已失效"，让用户回到应用重新发起。
- 没登录时带着同一份签名参数去 `/sign-in`，登录后经续跑回到这里。
- 同意和拒绝都用 fetch 发 JSON（这两个端点只收 JSON），`oauth_query` 是页面地址上原样的签名参数；拒绝不带 `scope`（Better Auth 先比较 scope 再看是否同意）。响应是 `{ redirect, url }`，页面整页跳过去。
- 申请 Select 时：没有角色就不能同意，链接到角色页；只有一个时默认选中。被封禁、邮箱没验证时说明原因，只给"拒绝"，同批准页。

**登录后续跑**：Better Auth 把没登录的授权请求带着签过名的参数（`sig`、`exp`）跳到 `/sign-in`。登录页认出这些参数时，把回到授权流程的地址放进 `next`，密码、两步验证、通行密钥、第三方登录完成后都经同一个 `next` 回去；从登录页进去注册的也一样。签名不对或过期的参数不续跑，当普通登录处理。测试覆盖每一种登录方式。

- **重新打开授权地址**，不用 Better Auth 的 `oauth_query`：登录页在服务端验过签名，把参数还原成 `/api/auth/oauth2/authorize?…`（去掉 `sig`、`exp`、`ba_*`，从 `prompt` 里去掉 `login`，去掉 `max_age`）放进 `next`。重新打开的是一次新的外部请求，强制同意、组合规则、封禁检查照样执行，签名也重新生成。
  - `oauth_query` 只在 Better Auth 自己的登录端点上起作用：第三方登录和注册后的登录都是服务端调用，没有请求对象，接不上；开了两步验证时它会在第一步的会话上先跑一遍授权。`/oauth2/continue` 不去掉 `login`，`prompt=login` 会循环。
  - 所以 `oauth_query` 只在 `/oauth2/consent` 上接受，其他端点的请求体带它时返回 `invalid_request`：Better Auth 对任何带它、写了会话 Cookie 的请求都会在内部续跑授权，密码登录带上它，就能在两步验证之前拿第一步的会话跑一遍。
  - `next` 里不带签名，所以登录、注册、第三方登录用多长时间都行（签名参数 10 分钟过期）；`next` 本来就能指向任何站内地址，指向授权地址不比直接打开它多给什么。
  - 去掉 `login` 和 `max_age` 是因为跟着 `next` 回去之前一定刚登录过：`max_age=0` 在 Better Auth 里永远不满足，留着会循环。
- 已经登录时：`prompt` 带 `login`，或者会话早于 `max_age` 的要求，照样显示登录表单；否则直接跳回授权地址。后一种是第三方网站用表单 POST 发起授权的情况：跨站 POST 不带 `SameSite=Lax` 的会话 Cookie，Better Auth 以为没登录。
- 跳往 `/api/` 下的地址一律整页导航（`location.replace`，服务端是 HTTP 重定向）：Next 的客户端路由会先发一次 RSC 的 fetch，Better Auth 对 fetch 返回 JSON，授权会跑两遍。用 replace 不留下登录页：从同意页按后退时，登录页上还没过期的签名参数会让授权再跑一次。认证页之间带着这种 `next` 的链接（登录、注册、重新登录）也用普通链接：对方页面已经登录时会 `redirect(next)`，在客户端路由下同样先 fetch。
- 要求重新登录时登录页对已登录的人开放，跟着改三处：不显示注册链接（已经登录的人打开注册页会直接回到 `next`，不用再登录一次）；第三方登录出错时回到登录页，带着 `next` 和错误留在这一页，不因为已经登录就跳走；用没绑定的第三方账号登录，补全注册页照常显示表单（以前已经登录就跳到用户中心），但不显示"先用原来的方式登录"的链接，理由和注册链接相同。
- 第三方登录出错时，回调把 `next` 带回登录页（`/sign-in?error=…&next=…`）。以前只带错误，授权流程和 `/device` 的 `next` 都会丢掉，改用密码登录以后去了用户中心。

**用户中心的"OAuth 应用"**（`/user/oauth-clients`）：

- 列表：名称、client_id（可以复制）、类型、回调地址、创建时间、已授权的用户数；被停用的标明"已被管理员停用"。页面上给出发现文档的地址，接入的人要用它。
  - 已授权的用户数：有同意记录、或者有没吊销没过期的令牌的用户，口径同安全页的"已授权的应用"。
  - 类型按认证方式显示：`none` 是"启动器或桌面程序"，其余是"网站"，导入的应用也这样分。
- 创建：名称、类型、回调地址（每行一条）。类型有两种，创建后不能改：
  - **网站**：机密客户端，`client_secret_basic`，授权码和刷新，`application_type: web`，`require_pkce: false`，scope 不限（`scopes` 为空，同导入的应用）；至少一条回调地址。
  - **启动器或桌面程序**：公共客户端，`none`，`require_pkce: true`，设备码和刷新，填了回调地址时再加授权码；`application_type: native`；scope 同公用应用，不含 `email`。
- 网站类型的 `require_pkce` 显式写 `false`（这一列为空时 Better Auth 对机密客户端也要求 PKCE）：论坛、CMS 的 OAuth 插件多半不发 PKCE，导入的机密客户端和 BS 的 Passport 也不要求；RFC 9700 只要求公共客户端必须用；申请 `offline_access` 又没带 `nonce` 时 Better Auth 照样要求。
- 启动器类型不给 `email`：公共客户端没有密钥，谁都能拿它的 client_id 发起设备码请求，理由同公用应用（规范建议限制公共客户端申请敏感的 scope）。导入的应用不动。
- client_id：32 个小写字母（CSPRNG），撞上唯一索引时重新生成。只用小写，因为 MySQL 的排序规则不分大小写，混用大小写会在那里撞上；不会是纯数字（导入的 BS 应用是），也不会和 `shared` 相同。
- 密钥：32 字节 CSPRNG，base64url 编码。表里只存哈希，同 Better Auth 的 `storeClientSecret: 'hashed'` 和导入器。只出现在创建和重置的响应里，响应带 `Cache-Control: no-store`，不进日志和审计（不变量 11）。页面显示一次，关掉就再也看不到。
- 回调地址：
  - 校验照 Better Auth 的 `validateClientRedirectUri` 复制一份（包的导出里没有它，同"scope 错误的重定向"复制的登记规则）：不能带 `#`、用户名和密码；`web` 只能是非环回地址的 https；`native` 的 https 不能是环回地址，http 只能是精确的 `localhost`、`127.0.0.1`、`[::1]`，其余必须是合规的自定义协议。
  - 每行去掉两端空白，忽略空行和重复的，原样保存：Better Auth 逐字比较，存规范化之后的地址，应用发来的就对不上了。最多 20 条，每条不超过 2048 个字符。
- 修改名称和回调地址；重置密钥（只有网站类型）；删除（确认框写明：已经授权的用户全部失效，接入这个应用的服务要重新配置）。
  - 改回调地址时只校验新加的，已有的照旧保留：BS 不限制回调地址，导入的应用里有 http 地址，不能因为改个名字就要先把它们改掉。
  - 授权方式只随回调地址增减授权码（连同 `response_types: ['code']`）：有回调地址就有授权码，删光了就去掉。其余授权方式、`require_pkce`、`application_type`、`scopes` 都不动。没有设备码的应用（网站类型、导入的 Passport 公共客户端）至少要留一条回调地址，删光了什么都做不了。`grant_types` 不会写成空的：Better Auth 把空的当成允许授权码。
  - 重置密钥、改回调地址都不吊销已签发的令牌和同意记录：刷新令牌要客户端认证，旧密钥拿不到新令牌，访问令牌最多再用一个有效期。要让全部授权立即失效，就删除应用。
  - 删除时，在同一个事务里删掉这个应用的 `device_codes` 和 `device_code_selections`（`device_codes` 按 client_id 字符串关联，没有外键）；令牌和同意记录随外键级联删掉。后台的删除也一样。
  - 被停用的应用照样能改、能重置密钥、能删，主人不能自己启用。
- 名称去掉两端空白后 1 到 255 个字符，同昵称；不能有控制字符（Unicode 的 Cc 类和双向文本的控制符）：同意页和批准页完整显示名称，这些字符能把它排成别的样子。
- 查看列表不受限制。创建、修改、重置密钥、删除要求没有被封禁；开着 `auth.requireEmailVerification` 时要求邮箱已验证（ADR-0018），同角色的管理。不设数量上限，也不限流，同 BS。
- 别人的应用和不存在的应用一样，返回 404。

**安全页的"已授权的应用"**（`/user/security`，在"启动器登录"后面）：每个应用一条，显示名称（公用应用照上面）、创建者、同意过的权限、令牌绑定的角色（去重）、最近一次授权的时间，"取消授权"按钮。数据来自同意记录和没过期的令牌，按应用合并。

**后台的"OAuth 应用"**（`/admin/oauth-clients`，要求 `oauthClients.manage`）：

- 列表：名称、client_id、主人（链接到用户详情页）、类型、状态、已授权的用户数（口径同用户中心）；按名称或 client_id 查找，按主人筛选（`?owner=<uid>`），分页同后台的其他列表。公用应用排在最前面。
- 停用、启用、删除，都写审计。已经是目标状态时什么也不做、不写审计，同 ADR-0036。
- "能对谁做"按主人判断（ADR-0036）：主人的身份要严格低于自己，自己的应用到用户中心改。
  - 没有主人的应用（公用应用，以及导入时主人已经不在的）按管理员算，所以只有超级管理员能处理：它们属于站点、不属于哪个用户，同设置、插件这些站点级的事。
  - 公用应用谁都不能删除，领域层按 client_id 逐字等于 `shared` 拦住。
  - 加锁顺序同后台的角色操作：先锁自己（`authorize`），读出应用的主人、锁住主人，再按主人重读应用，读不到就是应用不存在。
- 停用、删除给主人发通知（ADR-0036 的"管理员修改了你的账号"，加两种改动），启用不发：接入的服务突然坏掉，主人要知道是为什么。没有主人的不发。
- 后台不能改别人应用的名称、回调地址和密钥：这些是主人的配置，改错了第三方服务就坏了，需要时停用。
- 用户详情页加上"已授权的应用 N 个"，和会话数、启动器令牌数放在一起；"退出全部登录"的确认框写明一并吊销。另加"名下的 OAuth 应用 N 个"，链接到按主人筛选的列表。

### 权限和审计

| 权限 | 能做什么 | admin | superadmin |
|---|---|---|---|
| `oauthClients.manage`（新） | 后台的"OAuth 应用"页：查看全部应用，停用、启用、删除 | ✓ | ✓ |

| 审计动作 | 对象 | 详情 |
|---|---|---|
| `oauthClient.disable` | 应用（`oauth_clients.id`） | client_id、名称、主人的 uid（没有主人时为空） |
| `oauthClient.enable` | 同上 | 同上 |
| `oauthClient.delete` | 同上 | 同上，以及删除之前数的已授权的用户数（口径同列表）、没吊销没过期的访问令牌数和刷新令牌数 |

用户自己在用户中心的操作不写审计，同角色和材质。

### 接口

| 接口 | 用途 |
|---|---|
| `GET /api/oauth-clients`、`POST /api/oauth-clients` | 自己的应用：列表、创建（响应里有一次性的密钥） |
| `PATCH /api/oauth-clients/{id}`、`DELETE …` | 改名称和回调地址、删除 |
| `POST /api/oauth-clients/{id}/secret` | 重置密钥 |
| `GET /api/user/authorizations`、`DELETE /api/user/authorizations/{id}` | 已授权的应用：列表、取消授权 |
| `POST /api/user/device/approve`、`POST /api/user/device/deny` | 批准页：批准（带所选角色的 pid，不申请 Select 时为 `null`）、拒绝 |
| `GET /api/admin/oauth-clients` | 后台列表（`q`、`owner`、`page`） |
| `POST /api/admin/oauth-clients/{id}/disable`、`…/enable`、`DELETE …` | 后台操作 |

`{id}` 是 `oauth_clients.id`（自增整数），同其他接口的路径参数，也和审计的对象一致；client_id 是任意字符串，放进路径要编码，MySQL 的排序规则还忽略末尾空格。写接口认会话 Cookie，同 ADR-0022。

### 导入器

- 回调地址里有路径以 `/yggc/client/public` 结尾的一条（Janus 的公共客户端标记）：这个应用导入成公共客户端，即 `none` 加 PKCE、`application_type: native`、授权方式加上设备码；去掉这条标记地址和密钥；去掉之后没有回调地址了，就去掉授权码。报告里逐个列出。SJMCL 等启动器写死的 client_id 指向的就是这些应用，导入后照样能用。
- 个人访问客户端照旧不导入。Janus 的 `SHARED_CLIENT_ID` 多半就是它，迁移后启动器从发现文档拿到新的 `shared_client_id`。
- Janus 自己的表、`code_id_to_uuid` 不导入（ADR-0031 已经列出后者）。
- 整库替换清空 `oauth_clients` 时保留公用应用这一行。
- `MIGRATION.md` 写明：issuer 换成了 `https://新站/api/auth`，用 OIDC 登录本站的第三方网站要改发现地址，旧令牌全部作废（ADR-0001）；启动器重新登录一次。

### 事件和插件 API

不变：不加事件，不加拦截点。`packages/plugin-sdk/docs/migrating-from-bs.md` 里 yggdrasil-connect 一行在切片一落地时改成"核心已实现"。

## 后果

- 新迁移：插入公用应用；按查询补索引（按 `reference_id` 删令牌和同意记录，按用户和应用数令牌），实现时对照现有索引决定；`users.oauth_version`（见"吊销"）。
- Better Auth 的配置：三个有效期选项来自设置、进缓存键；设备码 10 分钟；新的 `disabledPaths`；`postLogin`（只用 `consentReferenceId`）和 `onAPIError.errorURL`（切片二）；`clientPrivileges`、`resourcePrivileges` 恒为 `false`；钩子覆盖 scope 规则、强制同意、授权前提、角色绑定、数量上限、刷新后删旧访问令牌、换授权码时检查会话、吊销时补上配对的令牌。设备码兑换的包装照旧依赖未公开的结构（ADR-0007），升级 Better Auth 时由下面的测试兜底。
- 领域层：
  - 进服、`validate`、`invalidate`、启动器上传和删除材质加上 OAuth 分支（`yggdrasil/tokens.ts`、`join.ts`）；
  - `revokeLogins`、改密码之后的回调、角色的转让和删除、取消授权，加上删 OAuth 令牌的函数，都在调用方的事务里；
  - 应用管理的用例和查询。
- 设置项：`tokenValidSeconds`、`tokenRefreshableSeconds`、`tokensPerUser` 的说明改成同时作用于 Yggdrasil Connect，`tokensPerUser` 写明 OAuth 按每个应用分别计数。
- `docs/schema.md`：`oauth_clients` 一行写公用应用、Janus 标记的导入规则；`oauth_access_tokens`、`oauth_refresh_tokens`、`oauth_consents` 的 `reference_id` 和删除时机；`device_code_selections` 的写入方式（批准的领域用例）和删除时机加上作废在途的登录；`verifications` 一行补上授权码；导入对照表的 oauth_clients 一节。
- i18n：两个授权页面、scope 的说明、用户中心和后台的两个应用页、安全页的新区块、错误码、审计动作、公用应用的名称和说明、设置项的说明。
- `PROGRESS.md`：每个切片落地时更新"Yggdrasil"和"认证和注册"两条，"还没做"里的 Connect 一条挪过去。
- 规范只是锁定了的 issue 里的草案。以后有变化，或者有新启动器要接，先照它的请求补兼容用例。
- 测试：
  - 不从 BS 录制契约用例：BS 的录制环境没有 Janus，要另外搭，Connect 的响应又几乎全是动态的（令牌、签名、时间）。改为照 PCL-CE、SJMCL、FluentCore 的请求形状写**启动器兼容用例**：设备码请求用 `shared_client_id` 和写死的导入 client_id、不带密钥；轮询到令牌；用 JWKS 的 `keys[0]` 和按 `kid` 两种方式验签；`aud` 等于 client_id；首次和刷新都有 `id_token` 和 `refresh_token`；userinfo 里有 `selectedProfile`；FluentCore 那样漏了 client_id 的刷新返回错误（不迁就；Better Auth 对公共客户端缺 client_id 返回 `invalid_request`）。
  - 四种数据库上的领域测试：scope 规则在每个入口；部分同意被拒；Select 时必须选角色、别人的角色被拒；设备码只能由认领者在待批准时批准，批准后不能换角色，过期或已兑换的不能批准；`user_id` 被拒；有效期跟着设置；超出上限删最早的；刷新后旧访问令牌失效、旧刷新令牌重放作废整组；进服的每一个条件；`validate`、`invalidate`、`refresh` 对 OAuth 令牌的结果；上传材质要 Join 和对应的角色；每一种吊销；停用应用后令牌失效、启用后恢复；公用应用不能申请 `email`、不能走授权码；发现文档和元数据字段（http 和 https）。
  - 应用管理（四种数据库）：密钥只存哈希、只在响应里出现一次；回调地址按类型校验，修改时已有的地址照旧保留；授权方式随回调地址增减，没有设备码的应用不能删光回调地址；新建的应用走通授权码和设备码流程；后台的"能对谁做"、没有主人的应用只有超级管理员能处理、公用应用不能删；删除时清掉设备码，审计的计数；被封禁、邮箱没验证时的限制。
  - e2e：设备码 → 打开 `/device` → 登录 → 选角色 → 同意 → 轮询拿到令牌 → 验 ID 令牌 → `join` → `hasJoined`；授权码加 PKCE，从没登录开始，经两步验证续跑；改密码之后令牌失效；在用户中心建一个网站应用，用它走完授权码流程。
  - 从 S1 移植过来的胶水代码修复后没有复审过，切片一、二落地时连同新的钩子各做过一次独立审核。切片三不改它们。
- 采纳时：ADR-0007、0018、0022、0023、0027、0030、0031、0036 的状态行和 README 的索引行注明由本 ADR 补充，ADR-0007 注明"创建 OAuth 客户端需要管理员会话"一句由本 ADR 取代。

## 考虑过的其他方案

- **令牌有效期用 Better Auth 的默认值（访问令牌 1 小时）**：Minecraft 客户端开局拿到令牌，之后进服不刷新，一小时后就进不了服。
- **Connect 单独一组有效期和上限的设置**：多三个设置项，站长分不清它们和启动器令牌的区别；对用户来说两种都是"启动器登录"。BS 的 Janus 也和 authserver 共用 `ygg_tokens_limit`。
- **给公共客户端和公用应用缩短有效期**（规范的建议）：启动器都是公共客户端，缩短就回到上一条的问题。authserver 的令牌同样交给公共的启动器，也是 3 天。
- **公用应用也允许授权码流程，回调可以是任意 https**（规范允许）：任何网站都能以公用应用的名义拿到能进服的令牌。
- **不提供公用应用**：PCL-CE、FluentCore 在没有写死 client_id 的站点上只能用 `shared_client_id`。
- **公用应用用设置项开关**：停用已经有 `disabled` 列，Better Auth 在每个端点上都认它；设置项还得另外让已签发的令牌失效。
- **改密码不吊销 OAuth 令牌**（Janus 和多数 OAuth 服务的做法）：盗号的人在改密码之前授权一个启动器，就留下了进服的能力；启动器令牌改密码时要删，Connect 令牌没有理由例外。代价是第三方网站的授权也要重来一次。
- **作废在途的登录时连同意记录一起删**：同意记录不是凭据，没有会话用不上；删掉只会让用户多点一次同意。
- **角色改名后令牌失效**（yggdrasil-connect 的做法）：进服按 UUID 核对，不看名字；userinfo 给的是现在的名字。改名就得重新登录启动器，没有换来什么。
- **`validate` 接受任意有效的 OAuth 令牌**（yggdrasil-connect 的做法）：只有 Read 或者没绑定角色的令牌会被说成有效，进服却被拒绝。
- **启动器上传材质只要求绑定了目标角色**（yggdrasil-connect：有 Read 或 Select）：只为认出玩家而申请 Select 的网站，就能改他的皮肤。
- **`refresh` 接受 OAuth 令牌**：clientToken 和按名字选角色在 OAuth 令牌上都没有对应；启动器刷新 OAuth 令牌走令牌端点。
- **元数据字段总是给出**：http 站点上启动器会在明文连接上传令牌；`ygg/meta` 契约用例会失败。
- **设备码流程的角色选择单独一个请求**（S1 的做法）：多一个端点，选择和批准之间有窗口，还要专门处理批准后改选（S1 审核发现 5）。合进批准请求，这些都不存在。
- **批准页用 Better Auth 的 `/device`、`/device/approve`、`/device/deny`，角色经请求头交给 before 钩子**（这份 ADR 起初的写法）：批准和拒绝按 id 无条件更新状态，钩子的检查和更新之间有窗口，选择也写不进同一个事务。
- **批准页按用户限流用 Better Auth 的 `customRules`**：它只能按 IP 计数。
- **允许只同意一部分 scope**：S1 审核发现 2 就出在这里；启动器拿到少于申请的 scope 时不会处理。
- **只有管理员能创建 OAuth 应用**（ADR-0007 原来的一句）：BS 里普通用户都能建，导入的应用很多属于普通用户，他们要能重置密钥、改回调地址；第三方网站接入本站也不该要找管理员。
- **用 Better Auth 管理客户端的端点**：它们不检查邮箱验证、不写审计，`delete-consent` 不删令牌；`create-client` 能设 `skip_consent`、任意 scope 和授权方式。
- **后台能改别人应用的配置**：改错了接入的服务就坏了，主人也不知道；处理违规的应用停用就够。
- **新建的网站应用要求 PKCE**（Better Auth 的默认）：现成的论坛、CMS 插件多半接不上，报错又看不出原因；机密客户端有密钥，申请 `offline_access` 又没带 `nonce` 时 Better Auth 照样要求。也考虑过让主人勾选，多一个选项，大多数人不知道该不该勾。
- **修改时重新校验全部回调地址**：导入的应用里有 BS 允许、现在不允许的地址，主人改个名字也要先改掉它们，对接的服务跟着坏。
- **修改时按类型重算全部授权方式**：导入的 Passport 公共客户端改一次回调地址就多出设备码，主人没有要过它。
- **重置密钥时吊销全部令牌**：刷新令牌要客户端认证，旧密钥换不出新令牌；要立即作废全部授权时删除应用。
- **没有主人的应用按普通用户算，普通管理员也能处理**：公用应用一停用，没写死 client_id 的启动器全都登录不了；导入时主人不在的应用多半是站点自己的对接，同属站点级的事。
- **吊销时标记 `revoked`，不删行**：我们自己的吊销没有"发现重放"的需要，删行最简单；Better Auth 自己标记的那些，校验照样认。
- **JWT 访问令牌**：规范要求不透明即可；不透明令牌一删就失效，JWT 要另外查吊销表。
- **签名密钥定期轮换**：要处理新旧密钥并存期间 SJMCL 只看 `keys[0]` 的问题，这次只有一把密钥，以后单独做。
- **把 authserver 令牌并进 OAuth 表**：ADR-0030 已经否决。
- **外挂 Janus 或 panva/oidc-provider**：ADR-0007 已经否决。
