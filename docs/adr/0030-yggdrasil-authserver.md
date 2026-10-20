# ADR-0030 Yggdrasil：authserver 令牌存进自己的表，不与 OAuth 令牌合并；修掉 yggdrasil-api 的越权和吊销缺陷；开了两步验证的账号在密码后面接验证码

- 状态：已采纳（后台退出全部登录、刷新令牌时在锁内核对角色的主人，由 ADR-0036 补充；进服、`validate`、`invalidate`、启动器上传材质认 OAuth 令牌，令牌的设置项也作用于 OAuth 令牌，元数据的 `feature.openid_configuration_url`，由 ADR-0037 补充）
- 日期：2026-10-18
- 补充 ADR-0016 的"不复现"一表：新增一类"yggdrasil-api 的安全缺陷"，ADR-0016 的其余部分不变

## 背景

只读的 Yggdrasil 端点已经落地：API 元数据、按 UUID 和按名字查角色。签名密钥可以在后台生成（ADR-0028）。还缺三组端点，没有它们，启动器登录不了，游戏服务器也验证不了玩家：

- authserver：`authenticate`、`refresh`、`validate`、`invalidate`、`signout`；
- sessionserver：`join`、`hasJoined`；
- 材质：`PUT`、`DELETE /api/user/profile/{uuid}/{skin|cape}`。

已经定下的：
- ADR-0007：authserver 令牌自己实现，并修复旧插件的两个已知问题（越权上传材质；邮箱大小写导致刷新后令牌失效）。它和 OAuth 令牌体系要不要统一，留到实现阶段。
- `docs/schema.md`：令牌只存 sha256；绑定的角色被删除或转让后令牌失效；每个用户的令牌数有上限（BS 的 `ygg_tokens_limit`）。进服记录只保留几十秒，放在缓存接口里，默认是进程内存，不建表。
- ADR-0015：角色创建时就分配 UUID，永不改变。
- ADR-0016：认证、进服、上传端点同样先录制，需要令牌的用例要在录制脚本里先登录。
- ADR-0022、ADR-0023：删除角色时的令牌、开了两步验证的用户能不能用 authserver 登录，都留给这个切片；改密码时 authserver 令牌要失效。
- ADR-0029：过期令牌加进 `core:auth-cleanup`。
- SDK 已经有 `yggdrasil.serverJoined` 事件。

读 yggdrasil-api 5.2.1 的源码（录制环境里的那份）得到的行为：

- 令牌是 HS256 的 JWT（密钥是 `.env` 的 `JWT_SECRET`），整个对象存在 Laravel 缓存里。两段过期：JWT 的 `exp` 是签发后 `ygg_token_expire_1`（默认 3 天），过了就不能用来进服，只能刷新；缓存的 TTL 是 `ygg_token_expire_2`（默认 7 天），过了就彻底失效。
- 每个用户在缓存里有一个令牌列表，键是邮箱。签发时数量达到 `ygg_tokens_limit`（默认 10），就挤掉最旧的。
- `authenticate`、`signout` 按请求里的 `username` 节流：同一个 `username` 两次请求间隔不到 `ygg_rate_limit`（默认 1000 毫秒）就返回 403。
- authserver 只收 JSON：其他 Content-Type 返回 **200**，响应体是 `{"error":"Unsupported Media Type","errorMessage":…}`。
- BS 的 TrimStrings 对 JSON 请求体里所有字符串做 trim，**包括密码**；ConvertEmptyStringsToNull 再把空串换成 null。
- 用户改密码时，吊销他的全部令牌。
- 缺陷：
  1. 上传、删除材质只检查令牌有效，不检查角色归属。任何人用自己的令牌就能改别人角色的材质，扣的还是对方的积分（ADR-0007 说的越权）；
  2. 令牌列表的键：`authenticate` 用邮箱原样，`refresh` 用小写的邮箱。邮箱里有大写字母的用户，刷新之后列表就分成了两份（ADR-0007 说的大小写问题）；
  3. `signout` 按小写的 `username` 找令牌列表：用角色名 signout 时什么也没吊销，却照样返回 204；
  4. `join` 记下的客户端 IP 用 Whip 取，没有配白名单：任何人发来的 `X-Forwarded-For`、`CF-Connecting-IP` 都采信；
  5. 复用自己上传过的材质时，检查了衣柜费够不够，但没有扣。

还没定的：令牌存在哪、长什么样；两步验证；限速；进服记录；材质上传怎么接进现有的用例；契约测试怎么录有状态的流程。

## 决定

### 范围

这次做：
- authserver 五个端点、sessionserver 两个端点、材质上传和删除；
- 令牌表和它的失效规则；
- 用户中心：仪表盘上的"启动器配置"卡片，安全页上的"启动器登录"列表；
- 四个设置项，见"设置项"；
- 契约测试的场景用例。

不做：
- Yggdrasil Connect（OIDC 和设备授权）：另写 ADR。到时进服校验加一个分支，按 OAuth 访问令牌的哈希查表（ADR-0007），authserver 这条路不变。
- 正版验证（BS 的 mojang-verification 插件写的 `mojang_verifications`）：交给插件。
- Yggdrasil 操作日志和"最近活动"（BS 的 `ygg_log`、`ygg_show_activities_section`）。
- 管理员查看或吊销别人的启动器登录：需要时随后台用户管理做。

### 令牌

新表 `yggdrasil_tokens`：

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | 自增 | 主键 | |
| access_token_hash | varchar(64) | 非空，唯一 | 访问令牌的 sha256，base64url，与 OAuth 令牌相同（`auth/auth.ts` 的 `sha256`） |
| client_token | varchar(255) | 非空 | 客户端给的值原样保存；没给就由服务端生成 |
| user_id | integer | 非空；外键 → users，cascade | |
| player_id | integer | 可空；外键 → players，cascade | 绑定的角色。删除角色时令牌一并删除 |
| created_at | 时间 | 非空 | 签发时间 |
| valid_until | 时间 | 非空 | 在这之前令牌**有效**：能进服、能上传材质、`validate` 返回 204 |
| expires_at | 时间 | 非空 | 在这之前令牌**可刷新**；过了就彻底失效，`core:auth-cleanup` 在过期 1 天后删除 |

- **不与 OAuth 令牌合并**：authserver 令牌有 clientToken、两段过期、每用户上限、用密码 signout，这些 Better Auth 的 OAuth 表都没有；硬塞进去要改它的表或者借用不相干的列，升级时还会和它的 schema 比对测试打架。合并的好处只有"进服校验查一张表"，Connect 落地时多一个分支就够了。
- **令牌值是 32 字节随机数的十六进制**，对客户端不透明，不用 JWT：authlib-injector 的规范对格式没有要求，BS 早期的令牌就是 32 位十六进制，启动器都接受。签发时把明文返回给客户端，表里只存哈希。
- 两个时间在签发时按当时的设置算好，之后改设置不影响已经签发的令牌。这和 BS 一样：它的 JWT 过期时间和缓存 TTL 也是签发时定的。
- 每次使用都检查：绑定的角色此刻仍属于令牌的用户（转让角色以后，旧令牌按无效处理）；用户没有被封禁。封禁不删令牌，解封后没过期的令牌照样能用，同 BS。
- 改密码、重设密码时，在同一个回调里删除这个用户的全部令牌（核心的 `onPasswordChanged`，ADR-0023）。删除用户时由外键级联删除。
- **每用户上限**：签发的事务里，插入新令牌后，按 `id` 倒序保留前 N 个（设置项 `yggdrasil.tokensPerUser`），其余删除。两个事务同时签发，可能短暂地多出一个，下一次签发时就裁掉了。
- 令牌按用户关联，不按邮箱，缺陷 2 自然不存在。

### authserver

| 端点 | 校验 | 结果 |
|---|---|---|
| `authenticate` | 用户名、密码（见下）；用户没有被封禁；站点要求验证邮箱时，邮箱已经验证 | 签发新令牌 |
| `refresh` | 令牌可刷新；给了 clientToken 就必须一致；用户没有被封禁 | 删除旧令牌，签发新令牌，clientToken 和绑定沿用 |
| `validate` | 令牌有效；给了 clientToken 就必须一致；用户没有被封禁 | 204 |
| `invalidate` | 不校验 clientToken | 删除令牌；无论令牌存不存在都返回 204 |
| `signout` | 用户名、密码，同 `authenticate`，但不检查封禁 | 删除这个用户的全部令牌，204 |

逐条照 BS：
- 只收 JSON。其他 Content-Type 照 BS 返回 200 和 `Unsupported Media Type` 的响应体。
- 请求体里的字符串照 TrimStrings 和 ConvertEmptyStringsToNull 处理（`packages/api` 的 `phpTrim`）。`requestUser` 按 PHP 的真假判断：`"false"` 是真，`"0"` 是假。
- `username` 是邮箱格式（PHP 的 `FILTER_VALIDATE_EMAIL`）就按邮箱找用户，否则按角色名找角色的主人，与 CSL 等协议的名字查找规则相同（ADR-0015、ADR-0016）。元数据里已经声明了 `feature.non_email_login`。
- 用户名或密码为空返回 400 `IllegalArgumentException`。用户不存在和密码错误都返回 403，而且是**同一句文案**：BS 的两句文案不同，能用来探测账号是否存在。契约只比较 `errorMessage` 非空，不受影响。
- **密码**：在事务之外核对（scrypt 很耗 CPU，ADR-0018），用和网页登录同一个函数（`auth/password.ts`）。旧格式的哈希核对通过后，立刻换成当前算法（ADR-0007）。BS 会 trim 密码，旧站用户的哈希就是 trim 之后的值，所以先按 trim 之后的值核对；不通过、原值首尾又有空白时，再按原值核对一次。只用通行密钥或第三方登录、没有密码的账号，不能用 authserver 登录。
- `availableProfiles` 是用户的全部角色，按 `id` 排序，`id` 是角色的 UUID（`players.uuid`）。只有一个角色时自动绑定，同 BS。
- `user.id` 照 BS 由邮箱算出：`uuid5(NAMESPACE_DNS, 邮箱)` 的十六进制，`properties` 为空数组。改邮箱以后它会变，与 BS 相同。
- `refresh` 带 `selectedProfile` 时：没有任何角色叫这个名字，返回 400；令牌已经绑定了角色，返回 400；这个 id 不是用户自己的角色，返回 403。三条都照 BS。
- 并发刷新同一个令牌：用带条件的 DELETE 抢旧令牌，删到 1 行的那个请求才签发新令牌，另一个返回 403。

### 两步验证

开了两步验证的账号，authserver 登录要在密码后面直接接上 6 位验证码，例如密码是 `hunter2`、验证码是 `123456`，就填 `hunter2123456`。

- 启动器只有一个密码框，没有第二步。拒绝这些账号登录，等于让两步验证和启动器二选一；放行，网页上的两步验证就只是摆设。
- 只在用户开了两步验证（`users.two_factor_enabled`）时才拆：最后 6 位必须是数字，前面是密码。先核对密码，再核对验证码。
- 验证码按 Better Auth 两步验证插件的存法核对：密钥的解密方式、周期和位数都与它相同。失败计数和锁定共用 `two_factors` 的 `failed_verification_count`、`locked_until`，网页和启动器的错误次数合在一起算。这依赖 Better Auth 的内部存法，升级时由测试守着（ADR-0007 的做法）。
- 不接受备用码：备用码只能用一次，留给丢了验证器、要登录网页的时候。
- 失败文案和密码错误相同，文案里提示"开了两步验证的账号要在密码后面接上验证码"。
- `signout` 同样要求密码加验证码。
- `refresh` 不需要密码，所以两步验证只在第一次登录时检查，和网页上"记住我"的效果一样。
- 安全页的两步验证区块写明启动器的填法；在这之前，那里不能说启动器登录也受保护（ADR-0023）。

### 限速

两层，都用内存实现（ADR-0002 的限流接口，多实例时换成共享存储的驱动）：
- **间隔**：同 BS，`authenticate`、`signout` 按 `username`（trim 之后转小写）计，两次请求的间隔不能短于 `yggdrasil.loginIntervalMs`（默认 1000，0 表示不限），否则返回 403。BS 的键不转小写，`Steve` 和 `steve` 算两个人。
- **失败次数**：BS 没有这一层。15 分钟内失败 5 次，之后的请求一律返回 403，直到窗口过去，密码对了也不行。能对应到用户时按 uid 计，邮箱和各个角色名共用一个计数；对应不到时按 `username` 计。
  - 间隔只挡得住每秒一次：一天就是 8 万多次猜测。加上验证码之后，6 位数字在 ±1 个周期内每天被猜中的概率就不能忽略了。
  - 代价：知道别人邮箱的人，可以让他 15 分钟内登录不了启动器。网页登录和已经签发的令牌不受影响。

### 进服

- `join`：令牌有效；令牌绑定的角色的 UUID 等于 `selectedProfile`（小写、无连字符，逐字比较）；角色仍属于令牌的用户；用户没有被封禁。任何一条不满足都返回 403。成功后记下 `serverId → { 角色, 客户端 IP }`，保留 120 秒，同 BS。同一个 `serverId` 再次 join 会覆盖。
- 客户端 IP 用 `packages/api` 的 `clientIp()`（受信代理规则，ADR-0018），不采信任意来源的转发头（缺陷 4）。比较时统一 IP 的写法：去掉 IPv4 映射的 IPv6 前缀（`::ffff:`），IPv6 压缩成规范写法。游戏服务器传来的 `ip` 和 Node 看到的对端地址常常是同一个地址的两种写法。
- `hasJoined`：有这个 `serverId` 的记录、请求带了 `ip` 时与记录的 IP 相同、`username` 与角色**当前的名字**逐字相同，就返回带签名的角色资料，否则返回 204。记录不因为查询而删除，120 秒内可以查多次，同 BS。没有签名密钥时返回 400，同按 UUID 查角色。
- 进服记录放在缓存接口里，默认是进程内存，每次写入时顺手清掉过期的条目。多实例部署时 `join` 和 `hasJoined` 可能落在不同实例上，要换成共享存储的驱动（ADR-0002）。
- `hasJoined` 成功时发 `yggdrasil.serverJoined`。只在有订阅者时才开事务，没有订阅者就什么都不写：`hasJoined` 是游戏服务器每次有人进服都会调用的热路径（ADR-0021 提过这类高频事件）。

### 材质上传和删除

- 认 `Authorization: Bearer` 里的 authserver 令牌，要求令牌**有效**。缺少或无效返回 401 `UnauthorizedException`。
- 按 UUID 找角色，找不到返回 404 `NotFoundException`。**角色不属于令牌的用户返回 403**（缺陷 1）。`{type}` 只能是 `skin` 或 `cape`，否则返回 400（BS 会先扣分、建材质，再在改角色时报 500）。
- **上传**：multipart 表单，`file` 是 PNG，`model` 为 `slim` 时是 Alex 模型。
  - 走现有的上传用例（ADR-0025），私有；材质名取文件名去掉 `.png`，通不过材质名规则时用角色名。封禁、邮箱验证、尺寸、积分的检查都由用例负责，错误转成对应的 Yggdrasil 错误：尺寸不对等输入问题是 400，积分不够、被封禁是 403。
  - 用例返回 `texture_duplicate` 时，复用那个材质：不在衣柜里就先走"加入衣柜"的用例（照常收衣柜费，缺陷 5），再设给角色。已有材质的模型和请求的不同时返回 400：悄悄换成另一种模型，比报错更糟。
  - 设给角色走"换材质"的用例（ADR-0026）。
  - 请求体大小按 `texture.maxFileSizeKb` 限制；和网页上传共用每个用户每分钟 10 次的限额。
- **删除**：走"换材质"的用例，把对应的槽清空。
- 成功都返回 204。

### 错误响应

- 四种错误：`IllegalArgumentException` 400、`UnauthorizedException` 401、`ForbiddenOperationException` 403、`NotFoundException` 404。与现有的一样，不带 ALI 头。
- `errorMessage` 写进 i18n（`yggdrasil.errors.*`，同时写 `zh-CN`、`en`）。能确定是哪个用户时用他的界面语言，否则用站点默认语言，同 BS。
- 日志里不出现访问令牌、密码和验证码（不变量 11）。

### 用户中心

- **仪表盘的"启动器配置"卡片**（BS 的 `ygg_show_config_section`）：API 地址加复制按钮；一个可以拖进启动器的 authlib-injector 链接（`authlib-injector:yggdrasil-server:` 加上编码后的 API 地址）；三步说明：在启动器里添加外置登录服务器，用邮箱或角色名登录，开了两步验证的要在密码后面接验证码。总是显示，不设开关。
- **安全页的"启动器登录"列表**：每条显示签发时间、绑定的角色、状态（有效、可刷新），可以退出单个，也可以全部退出。BS 只能在启动器里用密码 signout；手机丢了、在网吧登过，用户需要在网页上处理。列表只显示自己的令牌，不显示 clientToken。
- 新组件先在 `packages/ui` 里找，没有就照 AGENTS.md 先补组件和 story。

### 设置项

都在 `yggdrasil` 分区：

| 设置项 | 默认值 | BS 的选项 |
|---|---|---|
| `yggdrasil.tokenValidSeconds` | 259200（3 天） | `ygg_token_expire_1` |
| `yggdrasil.tokenRefreshableSeconds` | 604800（7 天） | `ygg_token_expire_2` |
| `yggdrasil.tokensPerUser` | 10 | `ygg_tokens_limit` |
| `yggdrasil.loginIntervalMs` | 1000 | `ygg_rate_limit` |

- 可刷新期短于有效期时，按有效期算：`expires_at` 取两者中晚的那个。
- 导入对照照搬数值。`ygg_show_config_section` 不导入：卡片总是显示。

### 契约测试：场景用例

现有用例都是一问一答。authserver 和进服是有状态的，要按顺序发好几个请求，后面的请求要用到前面响应里的令牌。

- `cases.ts` 加一种场景用例：有序的若干步，每一步是一个请求；可以从前面的响应里取值（`accessToken`、`clientToken`），填进后面请求的请求体或请求头。
- 新的比对方式 `yggdrasil-token`：`accessToken` 只要求是非空字符串，而且和这个场景里之前出现过的都不同；请求里给了 `clientToken` 时逐字比较，没给时只要求非空；其余字段（`availableProfiles`、`selectedProfile`、`user`）深比较。
- 每个场景开始前，录制时恢复固定数据、清空 BS 的缓存（令牌、节流、进服记录都在里面）；回放时用一个新的核心实例。节流和间隔有专门的场景。
- 固定数据补上：用户的密码（用 BS 的 bcrypt 格式写进两边，NextSkin 这边按导入规则写进 `accounts`，顺便覆盖旧哈希的核对和换算法），上传场景要用的积分。
- 两步验证、启动器登录列表这些 BS 没有的行为，不进契约测试，写在 `packages/api`、`packages/domain` 的测试里。

### 不复现（补充 ADR-0016）

ADR-0016 的"不复现"一表加一类：

| 行为 | 理由 |
|---|---|
| yggdrasil-api 的安全缺陷：越权上传、删除别人角色的材质；用角色名 signout 不吊销令牌；进服 IP 采信任意来源的转发头；refresh 后令牌列表按邮箱大小写分裂；复用材质不扣衣柜费 | 复现等于复现漏洞。客户端只会在正常使用时碰到这些端点，正常使用下结果相同 |

能录到的写成 `deviation` 用例：上传、删除别人的角色（BS 204，NextSkin 403）；用角色名 signout 之后再 `validate` 旧令牌（BS 204，NextSkin 403）。都列进 `tests/contract/README.md` 的差异清单。

### 事件和插件 API

- 插件 API 不变。
- 发 `yggdrasil.serverJoined`，见"进服"。
- 插件运行时落地后，`authenticate` 也经过 `user.login` 拦截点，`method` 取 `'password'`。要不要让插件区分网页登录和启动器登录，随插件运行时定。

## 后果

- 新迁移：`yggdrasil_tokens`。`docs/schema.md` 的 Yggdrasil 一节从"要点"改成完整的表；`core:auth-cleanup` 加上这张表，按 `expires_at`。
- `packages/api` 的 Yggdrasil 路由补上三组端点；`yggdrasilError` 加上 401、404 两种。
- `packages/domain` 新增 Yggdrasil 的用例：签发、刷新、校验、吊销、进服，以及按 Better Auth 的存法核对 TOTP。
- 设置注册表加四项，i18n 补标签和说明；`docs/schema.md` 的导入对照补四行。
- 两步验证依赖 Better Auth 的内部存法（密钥加密方式、`two_factors` 的锁定列）。四种数据库上测试：网页上开启两步验证之后，启动器用"密码加验证码"能登录；只填密码、验证码错、验证码过期都被拒绝；错误次数和网页合在一起锁定。
- 有状态的契约场景要从 BS 录制，录制脚本要支持场景、恢复固定数据、清缓存；这是这个切片里最花时间的部分。
- BS 会 trim 密码，网页登录有同样的问题：旧站用户如果习惯在密码末尾带空格，导入后网页登录会失败。这次只处理 authserver；网页登录要不要照做，留给导入器。
- 测试（领域层在四种数据库上）：
  - 两段过期的边界；每用户上限；并发刷新只有一个成功；改密码、删除角色、转让角色（直接改 `players.user_id` 模拟）之后令牌失效；封禁时拒绝、解封后恢复；
  - 进服：令牌和角色不匹配、角色被转让、IP 两种写法相同、`hasJoined` 名字大小写不同返回 204、120 秒后过期；
  - 上传：别人的角色 403；重复的图复用并收衣柜费；模型不同返回 400；
  - 限速：间隔、失败次数，按 uid 合并邮箱和角色名。
- e2e：注册 → 在仪表盘复制 API 地址 → 用 authserver 登录拿到令牌 → `join` → `hasJoined` 返回带签名的资料 → 在安全页退出这个启动器登录 → `validate` 返回 403。

## 考虑过的其他方案

- **authserver 令牌存进 Better Auth 的 OAuth 表**：理由见"令牌"。
- **令牌照 BS 用 JWT**：令牌要在表里查（吊销、上限、绑定角色），JWT 的自包含没有用处，还会让人误以为可以不查表就信任它。
- **令牌存在缓存接口里，同 BS**：默认的缓存在进程内存里，重启就全部失效，所有启动器都要重新登录；按用户列出、吊销也要另外维护索引。
- **开了两步验证的账号不能用 authserver 登录，等 Yggdrasil Connect**：Connect 要等下一个切片，支持它的启动器也还不多，两步验证会变成"要安全就别用启动器"。
- **启动器专用密码**（用户在网页上生成一串随机密码，只能用于 authserver）：更干净，还能给没有密码的账号用；但要多一张表和一整套页面。"密码加验证码"现在就能用，以后需要时再加专用密码，两者不冲突。
- **只照 BS 按间隔限速**：理由见"限速"。
- **按 IP 限速**：国内很多玩家在学校、网吧和运营商的大内网后面，共享一个出口 IP。
- **`hasJoined` 查过一次就删掉记录**：BungeeCord 这类代理和后端服务器可能各查一次，BS 也不删。
