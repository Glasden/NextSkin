# 核心 schema 设计

跨表的约定（时间、布尔、JSON、命名、外键、UUID）见 ADR-0015，本文只写逐表的设计和从 BS 导入的对照。

迁移随功能切片落地（见文末"落地顺序"）。写迁移时以本文为准；需要偏离时，先改本文。

类型记号：

| 记号 | 含义 |
|---|---|
| 自增 | `autoIncrementId` 生成的整数主键 |
| 时间 | ISO 时间列：`varchar(24)`，UTC 毫秒格式，带格式检查（ADR-0015） |
| 开关 | `smallint`，只能是 0 或 1，列名以 `is_` 开头 |
| 长文本 | MySQL 上是 `longtext`，其他数据库是 `text` |
| BA 时间、BA 布尔 | Better Auth 声明的字段，按它的约定存储（ADR-0015） |

- 外键一栏写的是删除被引用行时的行为。所有外键列都建索引，下文不再逐一列出。
- 取值有限的字符串列（例如 `role`、`type`、`status`）都加 CHECK 约束，只允许说明里列出的值。

**加锁顺序**：在 READ COMMITTED 下，"先查、再改"挡不住并发插入。改动某个用户名下数据的用例（收藏、移出衣柜、举报、删除用户等），事务里的第一条写语句先锁住这个用户在 `users` 里的行，例如扣积分的 UPDATE；没有要改的列时，就执行一条不改值的 UPDATE。这样同一用户的这些操作会排队执行，SQLite 的写事务本来就是串行的。这条规则防的是同一用户数据上的丢失更新，不保证没有死锁：例如两个用户互相收藏了对方的材质，又同时删除账号，各自锁住了对方的材质。所以领域用例的事务都要能整体重试，遇到死锁（MySQL 1213、PG 40P01）或串行化失败（PG 40001）时从头执行整个用例（见 `packages/db/AGENTS.md`）。

**材质行是第二把锁**（ADR-0025、ADR-0026）：依赖材质的存在和可见性的用例，锁住自己的行之后，再锁住材质在 `textures` 里的行。改变存在或可见性的（删除、改公开或私有、改模型）锁住材质之后，才去动别人的衣柜、角色和头像；依赖可见性的（加入衣柜、换材质、设头像、举报）锁住材质之后，才判断它对自己是否可见。两边因此在材质行上排队。要给很多用户退积分时，按 uid 升序锁他们的行。

## 用户与认证

### users

Better Auth 的 user 模型加上我们的领域字段。领域字段都有默认值，不注册给 Better Auth。

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | 自增 | 主键 | 即 uid |
| nickname | varchar(255) | 非空 | Better Auth 的 `name` 字段 |
| email | varchar(255) | 非空，唯一 | 一律小写 |
| email_verified | BA 布尔 | 非空 | |
| image | text | 可空 | Better Auth 的字段，不写入：第三方登录不取头像（ADR-0034）；站内头像用 `avatar_texture_id` |
| two_factor_enabled | BA 布尔 | 可空 | 两步验证插件的字段 |
| created_at | BA 时间 | 非空 | 注册时间 |
| updated_at | BA 时间 | 非空 | |
| role | varchar(16) | 非空，默认 `user` | `banned`、`user`、`admin`、`superadmin` 之一，与 SDK 的 `UserRole` 相同 |
| score | integer | 非空，默认 0 | 只能原子增减，并同时写积分流水 |
| avatar_texture_id | integer | 可空；外键 → textures，set null | |
| locale | varchar(16) | 可空 | |
| theme | varchar(128) | 可空 | 主题 id；null 表示跟随站点默认，回落在读取时计算，卸载插件时清掉引用（ADR-0057） |
| registration_ip | varchar(45) | 可空 | 用于"同一 IP 注册数"限制 |
| last_check_in_at | 时间 | 可空 | 上次签到时间。签到用一条带条件的 UPDATE 同时改它和积分，保证一天只能签到一次 |
| email_version | integer | 非空，默认 0 | 邮箱每改一次加一；后台发起改邮箱、作废在途的登录时也加一（ADR-0036）。改邮箱的确认链接带着签发时的版本，版本对不上就作废（ADR-0024） |
| oauth_version | integer | 非空，默认 0 | 每删一次这个用户的 OAuth 令牌（改密码、作废在途的登录、取消对某个应用的授权）加一。令牌端点开始时记下它，签发之后锁住用户行再核对，对不上就撤回刚签发的令牌：吊销恰好提交在 Better Auth 消费设备码或旧刷新令牌、插入新令牌这两步之间时，删不到新令牌（ADR-0037"吊销"） |

`users` 和 `textures` 互相引用，所以 `avatar_texture_id` 在建完 `textures` 之后再加。

### Better Auth 的其他表

字段由 Better Auth 决定，表名和列名按 ADR-0015 映射（`packages/domain/src/auth/naming.ts`），迁移 0007–0020。以 Better Auth 的 schema 比对测试（`auth/schema.db.test.ts`）为准：缺表、缺列、缺命名索引都算失败；类型警告不能超出 Better Auth 用自己的迁移建出的库（serial 主键下它对自己建的表也报类型警告）。

- 列类型：日期 `authDateType`，布尔 `authBooleanType`，JSON 和数组 `authJsonType`，需要索引、外键或限长的字符串 `authStringType`（SQLite 上是 `text`：Better Auth 在 SQLite 上只认这个类型名），其余字符串 `text`。可空性与 Better Auth 一致，不加数据库默认值和 CHECK：取值由 Better Auth 决定，升级时可能新增。
- 索引名按 Better Auth 的规则：`<表>_<列>_idx`、`<表>_<列>_uidx`。它会按名字核对多列的表级索引，名字不对就当作缺失。外键名按我们的规则 `<表>_<列>_fk`，删除行为照 Better Auth 的声明。
- `passkeys.credential_id` 长 1364：WebAuthn 的 credential ID 最长 1023 字节，base64url 编码后 1364 个字符。MySQL 上这一列用 ascii 字符集（`authStringType` 的 `ascii` 选项），否则超过单列索引 3072 字节的上限。`passkeys.counter` 与 Better Auth 一样是 `integer`，规范允许的值最大到 2^32 - 1，超过 2^31 - 1 的认证器注册会失败。

| 表 | 插件 | 备注 |
|---|---|---|
| sessions | 核心 | |
| accounts | 核心 | 密码存在这里：`provider_id = 'credential'` 的那一行。第三方登录的绑定也在这里：`provider_id` 是 `plugin:<插件 id>:<Provider id>`，`account_id` 是第三方的 subject，令牌各列留空；`account_id`、`provider_id` 是 ascii 的 `authStringType(255)`，`(provider_id, account_id)` 和 `(user_id, provider_id)` 各有唯一索引（ADR-0034） |
| verifications | 核心 | 一次性令牌：找回密码 `reset-password:<令牌>`（值是 uid）；两步验证的挑战 `2fa-<随机>`（值是 uid）和它的尝试计数 `2fa-attempts-2fa-<随机>`（值是次数）；"信任这台设备" `trust-device-<随机>`（值是 uid）；通行密钥的 WebAuthn 挑战（标识是不带前缀的随机串）；第三方登录的暂存 `external-login:state:…`、`external-login:pending:…`（`…` 是 Cookie 里随机值的 sha256，ADR-0034）。Better Auth 写的标识按明文存储（`verification.storeIdentifier` 保持默认），后台按格式和值（uid）删除：作废在途的登录删掉找回密码链接和两步验证的挑战（连同尝试计数），关两步验证删掉两步验证的挑战和"信任这台设备"，邮箱改动生效时删掉找回密码链接（ADR-0036）。邮箱验证用的是 JWT，不经过这张表 |
| jwks | jwt | ID 令牌的签名密钥 |
| oauth_clients、oauth_resources、oauth_client_resources | oauth-provider | `client_id = 'shared'` 的一行是公用应用（ADR-0037），由迁移插入：没有主人和密钥，认证方式 `none`，授权方式只有设备码和刷新，scope 里没有 `email`。不能删除；导入器整库替换时保留这一行（id、停用状态不变）。用户中心创建的应用共同写 `client_id`、`name`、`user_id`、`disabled: false`、`redirect_uris`、`created_at`、`updated_at`；网站另写密钥哈希、`client_secret_basic`、`require_pkce: false`、`application_type: web`、授权码和刷新、`response_types: [code]`，`scopes` 留空；启动器写空密钥、`none`、`require_pkce: true`、`application_type: native`、设备码和刷新、`SHARED_CLIENT_SCOPES`，有回调地址时再加授权码和 `[code]`，没有时 `response_types` 为空。数组均写 JSON，其余列保持 null |
| oauth_access_tokens、oauth_refresh_tokens | oauth-provider | 令牌按我们指定的 sha256 存储（ADR-0007），和 `yggdrasil_tokens.access_token_hash` 同一种编码：进服和 authserver 先查启动器令牌、查不到再按同一个哈希查这里（ADR-0037）。Yggdrasil Connect 绑定的角色存在 `reference_id`（`player:<pid>`，刷新时沿用）；`reference_id` 是 ascii 的 `varchar(255)`，有索引（`<表>_reference_id_idx`），角色转让和删除时按它吊销 |
| oauth_consents | oauth-provider | Yggdrasil Connect 选择的角色存在 `reference_id`（`player:<pid>`，类型和索引同上）。改密码、作废在途的登录时保留，角色转让和删除时随角色删除（ADR-0037"吊销"） |
| oauth_client_assertions | oauth-provider | 只给 `private_key_jwt` 用，serial 下它的防重放不起作用，这种认证方式已关闭（ADR-0015）。表照建，Better Auth 的 schema 比对要求它存在 |
| device_codes | 设备授权 | `user_id` 是 text（uid 的字符串，没有外键）：打开批准页时认领（ADR-0007），删除账号、作废在途的登录时显式删掉这个用户认领了的、还没兑换的行 |
| two_factors | 两步验证 | |
| passkeys | 通行密钥 | 来自单独的 `@better-auth/passkey` 包 |

- 过期的会话、OAuth 访问令牌和刷新令牌、客户端断言、设备码，由每天一次的定时任务 `core:auth-cleanup` 在过期 1 天后删除。撤销了但还没过期的刷新令牌保留：oauth-provider 靠它发现令牌被重放（ADR-0029）。`verifications` 不在其中，Better Auth 每次查验证值时会删掉全部过期的行。

### device_code_selections

Yggdrasil Connect 设备流里，用户在批准页上选择的角色（ADR-0007、S1、ADR-0037）。批准页的领域用例在批准设备码的同一个事务里写入（`oauth/devices.ts`），不经过 Better Auth 的 `/device/approve`。

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| device_code | varchar(255) | 主键 | 按字符串记录，不按自增 id（S1 审核发现 7） |
| user_id | integer | 非空；外键 → users，cascade | 认领者 |
| player_id | integer | 非空；外键 → players，cascade | |
| created_at | 时间 | 非空 | |

令牌兑换（成功或失败都删，`auth/connect.ts`）、请求被拒绝、用户取消对这个应用的授权、作废在途的登录，或者角色被后台转让（ADR-0036）后删除这一行。设备码过期后没人处理的，由 `core:auth-cleanup` 删除（ADR-0029）。

## 角色

### players

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | 自增 | 主键 | 即 pid |
| user_id | integer | 非空；外键 → users，cascade | |
| name | varchar(50) | 非空 | 显示用，保留大小写；首尾空格在领域层去掉。宽度与 BS 相同 |
| name_key | varchar(100) | 非空，唯一 | `name.toLowerCase()`，所有按名字的查找都查这一列。个别字符小写后会变成两个字符，所以比 `name` 宽 |
| uuid | varchar(32) | 非空，唯一 | 创建时分配，之后不变（ADR-0015） |
| skin_texture_id | integer | 可空；外键 → textures，set null | |
| cape_texture_id | integer | 可空；外键 → textures，set null | |
| created_at | 时间 | 非空 | |
| updated_at | 时间 | 非空 | 改名、换材质、转让时更新。CSL 响应的 `Last-Modified` 和 USM 的 `last_update` 都取自这里 |
| score_paid | integer | 非空，默认 0 | 创建时实际扣的积分，删除时按它退还，不按现价（ADR-0022）。注册时一起创建的角色是 0；转让后清零 |

## 材质

### texture_files

一个文件一行。

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| hash | varchar(64) | 主键 | 存储键，也是 `/textures/{hash}` 的一部分。新文件是像素 hash，导入的旧文件是 BS 算的文件字节 sha256 |
| pixel_hash | varchar(64) | `active` 时非空；索引 | 上传查重用。不唯一：BS 只按文件字节查重，像素相同、字节不同的旧文件可能有好几份 |
| width | integer | `active` 时非空 | |
| height | integer | `active` 时非空 | |
| size_bytes | integer | `active` 时非空 | |
| ref_count | integer | 非空，不小于 0 | 引用这个文件的 `textures` 条数。增删材质条目时，在同一事务里原子增减 |
| status | varchar(16) | 非空 | `pending`（上传中）、`active`、`deleting` 之一 |
| claim_id | varchar(36) | 可空 | 当前认领的随机标识。认领、开始删除时换新值 |
| status_changed_at | 时间 | 非空 | 进入当前状态的时间，用来判断认领是否过期、删除中的行能否开始删 |
| delete_attempted_at | 时间 | 可空 | 最近一次开始删除存储对象的时间 |
| delete_confirmed_at | 时间 | 可空 | 最近一次删除尝试成功的时间 |
| created_at | 时间 | 非空 | `/textures/{hash}` 的 `Last-Modified`。BS 用的是文件的修改时间，导入时取旧文件的修改时间 |

像素 hash、宽高和字节数在 `pending`、`deleting` 状态下可以为空：清理孤儿对象时插入的行不知道这些值。用一条 CHECK 约束保证 `active` 的行四项齐全。

存储里的对象在数据库事务之外读写，数据库的锁和事务都管不到它。两条规则：

- **先认领再动对象。** 要写入或删除某个 hash 的对象，先在这一行上认领（进入 `pending` 或 `deleting`），拿到新的 `claim_id` 并提交。之后每一步都带着 `claim_id` 做带条件的 UPDATE，改不到行，说明认领已经被别人接手，立即停下。同一行上的写入会被数据库排队，后执行的一方按最新的值重新判断条件。不要改成"查 `textures` 里还有没有引用"：跨表的子查询在 READ COMMITTED 下看不到并发事务刚提交的引用。
- **删除中的行要留够冷却期。** 远程存储的删除请求超时以后，仍可能在存储端执行。所以 `deleting` 的行要一直留着，直到最近一次删除尝试开始之后过了冷却期 L。L 要远长于存储客户端的请求超时加重试。行还在，就没有人能在这个 hash 上写新对象，迟到的删除请求删掉的只会是本来就要删的旧对象。

流程：

- **复用已有文件**：`ref_count = ref_count + 1 where hash = ? and status = 'active'`，改到一行才继续，并在同一事务里插入材质条目。
- **上传新文件**：
  1. 认领：没有行就插入 `pending` 行；有 `deleting` 行、但还没开始删除（`delete_attempted_at` 为空），就把它改回 `pending`。两种情况都换上新的 `claim_id`，提交。遇到 `active` 改走复用；遇到 `pending`，或者已经开始删除的 `deleting`，稍后重试；
  2. 写入对象。本地磁盘先写临时文件（文件名带 `claim_id`）再改名，S3 的 PUT 本身是原子的；
  3. 激活：在事务里执行 `status = 'active', ref_count = 1 where hash = ? and status = 'pending' and claim_id = ?`，同时写入宽高等元数据，插入材质条目。改不到就放弃这次上传，从头重试；已经写入的对象不要删。
- **删除材质条目**：在同一事务里 `ref_count = ref_count - 1`。
- **标记回收**：`status = 'deleting' where hash = ? and ref_count = 0 and status = 'active'`，与引用数减到 0 在同一个事务里。过期的认领（`pending` 超过租期）同样改成 `deleting`。
- **删除存储对象**：标记之后先等一段时间 D，留给"刚删掉又上传同一张图"的情况把这一行改回 `pending`。然后：
  1. 提交 `claim_id = 新值, delete_attempted_at = 当前时间, delete_confirmed_at = null where hash = ? and status = 'deleting' and status_changed_at < 当前时间 - D`，改到一行才继续；
  2. 删除对象，对象不存在也算成功。如果从第 1 步提交到发出请求已经过了 L 的一半（例如进程被挂起过），放弃这次尝试；
  3. 成功后提交 `delete_confirmed_at = 当前时间 where hash = ? and claim_id = ?`。
- **删行**：`delete where hash = ? and status = 'deleting' and delete_confirmed_at is not null and delete_attempted_at < 当前时间 - L`。这时最近一次删除尝试已经成功，更早的尝试也都已超过冷却期。
- **存储里有对象、表里没有行**：清理任务先插入一条 `deleting` 行来认领这个 hash，再按上面的流程删除；插入时发现已经有行，说明不是孤儿，跳过。修改时间的宽限期只用来挑选候选，不起互斥作用。
- **临时文件**：文件名里的 `claim_id` 已经不是任何 `pending` 行的当前认领、修改时间又早于租期的，直接删除。临时文件从不对外提供，删掉总是安全的；原上传者改名时发现临时文件没了，就让这次上传失败。
- 取值（ADR-0025）：认领租期 10 分钟；D 1 小时；L 由存储驱动给出，本地磁盘的删除是同步完成的，L 为 0。
- 推进这些步骤靠延迟任务，不靠定时扫描（ADR-0025）：标记回收的事务里排一个 D 之后执行的任务，去重键是 hash；认领 `pending` 的事务里排一个租期到期时执行的检查任务。孤儿对象和遗留的临时文件要遍历整个存储才找得到，由每周一次的定时任务 `core:texture-sweep` 扫描（ADR-0029）：候选是修改时间早于 1 天的对象，文件名不是材质 hash 的跳过。
- 回收文件时，一并删掉这个 hash 的出图缓存（ADR-0017、ADR-0025）。
- `/textures/{hash}` 只响应 `active` 的行。
- 外键 `textures.hash → texture_files` 的 `restrict` 只是兜底：引用计数出错时，至少数据库里的行删不掉。

### textures

材质库里的条目。多个条目可以指向同一个文件。

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | 自增 | 主键 | 即 tid |
| hash | varchar(64) | 非空；外键 → texture_files，restrict | |
| name | varchar(128) | 非空 | |
| type | varchar(8) | 非空 | `steve`、`alex`、`cape` 之一，与 BS 和 SDK 相同 |
| description | text | 可空 | 原 texture-description 插件的功能。新写入的不超过 2000 个字符，按纯文本显示（ADR-0025） |
| uploader_id | integer | 可空；外键 → users，set null | 上传者删除账号后，公开材质保留、这一列置空；私有材质随账号删除（ADR-0023） |
| is_public | 开关 | 非空 | |
| likes | integer | 非空，默认 0 | 收藏数，即有多少个衣柜里有它（包括上传者自己的）。和 `closet_items` 的增删在同一事务里原子增减（不变量 5） |
| score_paid | integer | 非空，默认 0 | 上传者实付的存储费，删除时按它退还，不按现价。上传者改公开或私有时按现价重新计价、多退少补，这一列改成新的存储费（ADR-0025）；管理员下架不重新计价，这一列不变，所以不一定等于当前可见性的价格（ADR-0036） |
| created_at | 时间 | 非空 | |
| updated_at | 时间 | 非空 | |

皮肤库的索引按三种查询建（ADR-0025）：`(is_public, id, type)`、`(is_public, likes, id, type)`、`(uploader_id, id)`。`type` 放在最后："全部皮肤"是 `type in ('steve', 'alex')`，`type` 在前时 SQLite 和 PostgreSQL 都要额外排序；放在最后，按 `id` 或 `likes, id` 倒序扫索引就能边扫边过滤，四种数据库的执行计划都已看过。

### closet_items

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| user_id | integer | 主键第一列；外键 → users，cascade | |
| texture_id | integer | 主键第二列；外键 → textures，cascade | |
| name | text | 非空 | 用户给这件衣服起的名字 |
| score_paid | integer | 非空，默认 0 | 加入时实际付的衣柜费，移出时按它退还，不按现价（ADR-0025）。上传时自动放进衣柜的那一件也收 |
| created_at | 时间 | 非空 | |

另建 `created_at` 上的索引，供首页的领奖台按时间区间取最近 7 天加进衣柜的行（ADR-0032）。

删除用户时，用例先锁住这个用户的行（见开头的"加锁顺序"），再逐条移除衣柜并减少对应材质的收藏数，最后删用户。外键的 `cascade` 只是兜底，它不会更新收藏数。不先锁用户的行，就挡不住两步之间并发加进来的收藏：它会被级联删除，收藏数却不会扣回。

### reports

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | 自增 | 主键 | |
| texture_id | integer | 可空；外键 → textures，set null | 材质删除后保留举报记录 |
| uploader_id | integer | 可空；外键 → users，set null | 举报时材质的上传者 |
| reporter_id | integer | 可空；外键 → users，set null | |
| reason | 长文本 | 非空 | BS 的列是 `longtext`，没有长度限制。新举报在领域层限制为 1 到 500 个字符（ADR-0026） |
| score_paid | integer | 非空，默认 0 | 举报时实际付的花费，采纳时按它退还（ADR-0026） |
| status | varchar(16) | 非空 | `pending`、`resolved`、`rejected` 之一 |
| resolution | varchar(32) | 可空 | 处理方式，取值与 SDK 事件 `report.resolved` 的 `action` 相同。导入的旧记录为空，材质已不存在的待处理举报除外（见导入对照） |
| resolver_id | integer | 可空；外键 → users，set null | |
| created_at | 时间 | 非空 | |
| resolved_at | 时间 | 可空 | |

- `(reporter_id, texture_id)` 唯一：BS 不允许同一个人重复举报同一个材质，无论之前的举报处理与否；举报还会改积分，只靠"先查再插"在并发下会重复结算。用户或材质删除后这两列会被置空，三种数据库都把 NULL 视为互不相同，这些旧记录不会挡住任何新举报，这正是想要的。
- 另建 `(status, id)` 索引，供后台按状态列出举报。
- 待处理的举报总是指向存在的材质：材质删除时，在同一个事务里把它的待处理举报一并结案（ADR-0027）。所以 `status` 是 `pending` 的行，`texture_id` 不为空。
- 状态只从 `pending` 往外推进，用带条件的 UPDATE（`where status = 'pending'`），改不到行就是已经被处理过（ADR-0027）。

## 积分

### score_transactions

SDK 的 `adjustScore` 要求"原子地增减积分并记流水"。

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | 自增 | 主键 | |
| user_id | integer | 非空；外键 → users，cascade | |
| delta | integer | 非空 | |
| balance | integer | 非空 | 变动后的余额 |
| reason | varchar(128) | 非空 | 原因的 i18n 键，例如签到、上传材质、导入。插件写的是插件自己的文案键，按插件的文案翻译，插件卸载后显示"来自插件 {id}"（ADR-0041） |
| subject_type | varchar(32) | 可空 | 关联对象，例如上传材质时是 `texture` |
| subject_id | integer | 可空 | 关联对象的 id。退还积分不查流水，按对象行上记的实付数（例如 `players.score_paid`，ADR-0022） |
| plugin_id | varchar(64) | 可空，不建外键 | 写这一笔的插件（能力 `users.score`，ADR-0041）；核心自己写的为空。卸载之后照样要说明来源，同 `audit_logs.actor_plugin_id` |
| plugin_key | varchar(255) | 可空 | 插件给的幂等键，在本插件内唯一，永久保存 |
| created_at | 时间 | 非空 | |

另建 `(user_id, id)` 索引。改余额和写流水在同一事务里：先用 `score = score + ?` 原子更新（扣减时带上"余额足够"的条件），再读回余额写流水。

- `plugin_id`、`plugin_key` 要么都为空、要么都不为空（CHECK）；`(plugin_id, plugin_key)` 唯一，核心自己的流水两列都是 NULL，互不冲突。
- 另建 `(plugin_id, id)` 索引：后台的插件详情页按插件统计累计加减的积分、取最近几笔，不用把这个插件的全部流水排序。
- 插件改积分时先按 `(plugin_id, plugin_key)` 查流水：参数相同就当作已经做过，什么都不改；不同就拒绝。并发的同一个键撞上唯一索引时，整个事务回滚后再查一次（ADR-0041）。插件改积分不写审计。

`users.score` 只经过领域层的 `adjustScore` 修改，导入器例外（ADR-0021）。每个用户流水的 `delta` 之和恒等于 `score`。

## 后台任务

事件投递、插件任务和核心自己的任务（例如发邮件）都是 `jobs` 里的一行。认领、重试、死信的规则见 ADR-0021。

### jobs

只放还没完成的任务：完成就删除，彻底失败就移到 `failed_jobs`。事件在业务事务里按订阅者展开成任务，不另建事件表。

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | 自增 | 主键 | |
| name | varchar(128) | 非空 | 处理函数的键，例如 `core:mail`、`plugin:<id>:job:<任务名>`、`plugin:<id>:on:<事件名>` |
| payload | 长文本 | 非空 | JSON；事件投递时是完整的事件信封 |
| dedupe_key | varchar(255) | 可空 | |
| run_at | 时间 | 非空 | 最早执行时间；执行期间是租约到期时间 |
| lease_id | varchar(36) | 可空 | 本次认领生成的随机值，收尾时按它确认租约还是自己的 |
| attempts | integer | 非空，默认 0 | 已经开始执行过几次，认领时加一 |
| last_error | varchar(500) | 可空 | 核心的任务只记固定的错误码 |
| created_at | 时间 | 非空 | |

- `(name, dedupe_key)` 唯一。表里只有未完成的任务，所以去重只针对还没执行完的同名任务；不带去重键的任务是 NULL，互不冲突。
- 另建 `(run_at, id)` 索引，供执行器取到期的任务。

### failed_jobs

死信。列：`id`（自增）、`name`、`payload`、`dedupe_key`（不建唯一索引）、`attempts`、`last_error`，类型同 `jobs`；`created_at`（原任务的入队时间）、`failed_at`（时间，建索引）。

- 保留 30 天：每次写入时，在同一事务里删掉 `failed_at` 早于 30 天的行。
- 邮件任务进死信时，载荷里去掉链接（带着令牌）。
- 核心任务（`core:`）的死信在后台的失败任务页处理，插件任务（`plugin:<id>:`）的在插件详情页（ADR-0051）。
- 诊断包不导出载荷和 `last_error`。

### job_schedules

定时任务的条目，一个条目一行（ADR-0021、ADR-0029）。条目本身（cron 表达式、任务名、载荷）写在代码或插件 manifest 里，表里只记调度状态。

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| name | varchar(128) | 主键 | 条目名，也是入队时的去重键。核心条目以 `core:` 开头 |
| cron | varchar(255) | 非空 | 算出 `next_run_at` 时用的五段 cron 表达式 |
| time_zone | varchar(64) | 非空 | 算出 `next_run_at` 时用的时区 |
| next_run_at | 时间 | 非空 | 下一次执行的时间 |

- 调度器每 30 秒读一次整张表。到期的条目用条件 UPDATE 把 `next_run_at` 从读到的旧值推到从现在起的下一次，影响 1 行才在同一个事务里入队。
- `cron` 或 `time_zone` 和当前的不一致，就按当前的值从现在起重算，这一轮不触发。
- 不建其他索引：行数就是条目数。

## 站点设置

### settings

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| namespace | varchar(64) | 主键第一列 | 核心是 `core`，插件是 `plugin:<id>`。加前缀是为了不和插件 id 冲突 |
| key | varchar(128) | 主键第二列 | |
| value | 长文本 | 非空 | JSON |
| updated_at | 时间 | 非空 | |

- 每个设置项的类型和默认值在设置注册表（`packages/domain/src/settings/registry.ts`）里声明，表里只存和默认值不同的项。核心的键名用点分隔，例如 `site.url`、`yggdrasil.signingKey`。
- 机密项（例如 Yggdrasil 的签名私钥）用 `.env` 里的 `NEXTSKIN_SECRET` 加密后存储（AES-256-GCM，附加数据绑定 namespace 和 key，信封带版本号，见 `settings/codec.ts`），导出诊断包时排除。代价：丢了 `.env` 里的密钥，这些值也就找不回来了，与 Better Auth 存 `jwks` 私钥的方式相同。

## 审计

### audit_logs

管理操作的记录，即操作者凭具名权限动了别人的东西（ADR-0027）。

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | 自增 | 主键 | |
| actor_type | varchar(16) | 非空 | `user`、`system`、`plugin` 之一，同 SDK 的 `Actor` |
| actor_user_id | integer | 可空，不建外键 | 操作者是用户时的 uid |
| actor_plugin_id | varchar(64) | 可空 | 操作者是插件时的插件 id |
| action | varchar(64) | 非空 | 例如 `report.resolve`，取值见领域层导出的动作清单（ADR-0027、ADR-0036） |
| subject_type | varchar(32) | 非空 | 例如 `user`、`texture`、`report`、`setting` |
| subject_id | integer | 非空，不建外键 | 站点设置没有整数 id，记 0，键名在 `details` 里（ADR-0028） |
| details | 长文本 | 非空 | JSON：操作时的快照，例如材质名、角色的新旧值。页头代码、自定义 CSS 记改前改后的全文，一条可能超过 64 KB（ADR-0063，迁移 0048 把 MySQL 上原来的 `text` 放宽） |
| ip | varchar(45) | 可空 | 用 `clientIp()` 解析；脚本和系统操作为空 |
| created_at | 时间 | 非空 | |

- 两个 id 列都不建外键：用户、材质删除之后，记录照样要说明是谁、对什么做的。这是 ADR-0015"核心表之间都声明外键"的例外。删除账号时，审计记录不删。
- `actor_type` 加 CHECK 约束；`subject_type`、`action` 不加，在领域层校验：以后每个管理切片都会加新值，SQLite 改 CHECK 约束要重建整张表。
- 和业务写入在同一个事务里写入。`details` 里不能出现不变量 11 列出的内容：机密设置项只记改了哪一项，不记值（ADR-0028）。
- 另建 `(subject_type, subject_id, id)`、`(actor_user_id, id)` 索引。按时间列出用主键倒序。
- 按设置项 `audit.retentionDays` 清理，默认 0 表示永久保留。每天一次的定时任务 `core:audit-log-cleanup` 按主键从小到大分批删除，遇到不早于截止时间的行就停，不为 `created_at` 另建索引（ADR-0029）。

## Yggdrasil

### yggdrasil_tokens

authserver（启动器用邮箱或角色名加密码换来的）令牌，与 OAuth 令牌分开存放（ADR-0030）。

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | 自增 | 主键 | |
| access_token_hash | varchar(64) | 非空，唯一 | 访问令牌的 sha256，base64url，与 OAuth 令牌相同。明文只在签发时返回给客户端 |
| client_token | varchar(255) | 非空 | 客户端给的值原样保存；没给就由服务端生成 |
| user_id | integer | 非空；外键 → users，cascade | |
| player_id | integer | 可空；外键 → players，cascade | 绑定的角色。删除角色时令牌一并删除 |
| created_at | 时间 | 非空 | 签发时间 |
| valid_until | 时间 | 非空 | 在这之前令牌有效：能进服、能上传材质 |
| expires_at | 时间 | 非空 | 在这之前令牌可刷新；不早于 `valid_until` |

- 另建 `(user_id, id)`（裁剪上限、列出）、`(expires_at)`（清理）索引。
- 两个时间在签发时按当时的设置算好，之后改设置不影响已经签发的令牌。
- 每次使用都检查：绑定的角色此刻仍属于令牌的用户（转让之后按无效处理），用户没有被封禁。封禁不删令牌。后台转让角色时，在同一个事务里删掉绑定它的令牌（ADR-0036）。
- 签发的事务先锁住用户行（同一用户的签发依次进行），再插入新令牌，按 `id` 倒序只保留 `yggdrasil.tokensPerUser` 个。用密码登录时还要锁住 `accounts` 里密码那一行、确认它仍是核对过的哈希，改密码的吊销才不会漏掉正在签发的令牌。
- 刷新用带条件的 DELETE 抢旧令牌，删到 1 行才签发新令牌。带 `selectedProfile` 时，锁住用户行之后再确认角色属于令牌的用户（ADR-0036）。
- 改密码、重设密码时删除这个用户的全部令牌。经 Better Auth 改的密码已经先提交了，这时删令牌单独提交，不与密码变更事件放在同一个事务里；后台改密码（包括收回账号）和命令行的 `set-password` 在同一个事务里改密码、删令牌，后台删通行密钥、解绑、退出全部登录也在各自的事务里删令牌（ADR-0036 的"作废在途的登录"）。
- 过期超过 1 天的由 `core:auth-cleanup` 按 `expires_at` 删除（ADR-0029）。

进服记录（serverId 对应哪个角色和客户端 IP）只保留 120 秒，放在缓存接口里，默认是进程内存，不建表。签名私钥存在 `settings` 的机密项里。

## 通知

站内通知（ADR-0052）：系统通知、管理员发的、插件发的都存在 `notifications`，一个收件人一行。系统通知和插件通知存类型（或文案键）和参数，读的时候按收件人的语言渲染；管理员写的原文存在 `notification_broadcasts`，每个收件人的那一行只引用它。

### notifications

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | 自增 | 主键 | |
| user_id | 整数 | 非空，外键 → users，cascade | 收件人 |
| type | varchar(32) | 非空 | 系统通知的类型（`report.resolved`、`report.pending`、`texture.removed`、`account.changed`），或 `message`（管理员发的）、`plugin` |
| params | 长文本 | 可空 | JSON：系统通知和插件通知的参数 |
| broadcast_id | 整数 | 可空，外键 → notification_broadcasts，cascade | 只有 `message` 有 |
| plugin_id | varchar(64) | 可空 | 只有 `plugin` 有。不建外键，同 `score_transactions.plugin_id` |
| title_key、body_key | varchar(128) | 可空 | 插件的文案键，只有 `plugin` 有，`body_key` 可以为空 |
| link | varchar(500) | 可空 | 插件给的站内路径。系统通知的链接按类型和参数算出来，不存 |
| read_at | 时间 | 可空 | 未读为空 |
| created_at | 时间 | 非空 | 群发写出的行记发送的时刻，不记展开到这一行的时刻 |

- 索引：`(user_id, read_at)` 数未读，`(user_id, id)` 翻页，`(broadcast_id, user_id)` 唯一（展开重跑不会写重），`(plugin_id, id)` 给卸载插件时的清理用。
- 未读数只数到 100（子查询带 `limit`）。
- 列表、摘要和未读数连上 `notification_broadcasts`，不看已经撤回的发送：撤回当场生效，行由任务稍后分批删掉。
- 系统通知和触发它的业务写入在同一个事务里写。`report.pending` 用一条 `INSERT … SELECT` 写给还没有未读 `report.pending` 的审核人。
- `core:notification-sweep` 每天按 id 从小往大删掉早于保留期（设置 `notifications.retentionDays`，默认 365，0 不清理）的通知，已读、未读都删，遇到没过期的就停，同审计日志。
- 卸载插件时 `core:plugin-cleanup` 按 `(plugin_id, id)` 分批删掉它发的通知。

### notification_broadcasts

管理员的每一次发送。

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | 自增 | 主键 | |
| sender_id | 整数 | 可空，外键 → users，set null | 发送人，注销后为空 |
| audience | varchar(16) | 非空，CHECK | `all`（不含被封禁的）、`users`、`admins`、`specific` |
| title | varchar(255) | 非空 | 去掉首尾空白后 1～60 个码位，由领域层校验 |
| body | 长文本 | 非空 | Markdown，0～5000 个码位 |
| through_uid | 整数 | 非空 | 发送那一刻最大的 uid，展开到它为止；指定用户时是收件人里最大的 uid |
| cursor_uid | 整数 | 非空，默认 0 | 已经展开到的 uid |
| recipient_count | 整数 | 非空，默认 0 | 已经写进去的行数，撤回后不减 |
| status | varchar(16) | 非空，CHECK | `sending`、`sent`、`recalled` |
| created_at | 时间 | 非空 | |
| finished_at | 时间 | 可空 | 展开完的时刻 |

- 另建 `sender_id` 索引（删除用户时置空）。
- 指定用户在发送的事务里直接写完，状态 `sent`。其余三种只写这一行、入队 `core:notification-fanout`：按 uid 升序每批 500 人，一批一个事务，先用条件 UPDATE 锁住这一行（状态不是 `sending` 就停），再写这一批、推进 `cursor_uid` 和 `recipient_count`。
- 撤回把状态改成 `recalled`（和展开争同一行的锁，展开在下一批停下），入队 `core:notification-recall` 分批删掉写出的行。
- 保留期的清理同时删掉早于保留期、已经展开完或者撤回了的发送记录，展开中的不删。

### plugin_notification_keys

插件通知的幂等键（ADR-0052）。不和通知记在同一行：通知会被用户删除、过保留期被清理，键要永久保留。

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| plugin_id | varchar(64) | 主键之一 | |
| plugin_key | varchar(255) | 主键之一 | 插件给的 key，1～255 个码位。列名同 `score_transactions.plugin_key`（`key` 是 MySQL 的保留字） |
| user_id | 整数 | 非空 | 不建外键：用户注销后键仍然保留 |
| fingerprint | char(64) | 非空 | uid、文案键、参数（按键排序）、链接组成的 JSON 的 sha256。同一个 key 再发，一样返回 `duplicate`，不一样拒绝 |
| created_at | 时间 | 非空 | |

- 键和通知在同一个事务里写入，并发的同一个键由主键兜住。
- 不清理：卸载插件不删，重装同一个 id 的插件，发过的不会再发。

## 导入

### import_runs

从 BS 导入的每次运行，试跑和导入各一行（ADR-0031）。导入清空业务数据时保留这张表。

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | 自增 | 主键 | |
| status | varchar(16) | 非空 | `running`、`succeeded`、`blocked`（有停止类问题，没有写入）、`failed`、`cancelled` 之一 |
| is_dry_run | 开关 | 非空 | 试跑 |
| entry | varchar(16) | 非空 | 入口：`setup`（安装向导）、`admin`（后台）、`cli`（命令行）之一 |
| started_by | varchar(255) | 可空 | 发起人的邮箱快照，命令行为空。不建外键：导入会替换用户表 |
| source | 长文本 | 非空 | JSON：旧库的类型、地址、端口、库名、表前缀，材质目录和时区。不含数据库密码和盐 |
| report | 长文本 | 可空 | JSON：对账报告，运行结束时写入 |
| started_at | 时间 | 非空 | |
| finished_at | 时间 | 可空 | 运行中为空 |

- 同一时刻最多一行 `running`：网页发起的由服务进程内的锁保证，命令行要求服务停着。服务启动时把遗留的 `running` 标为 `failed`，退出维护模式。
- 运行中的进度只在运行导入的进程的内存里，不写进这张表：导入事务提交之前，SQLite 上别的写入都要排队。
- 站点**未初始化**：没有用户，也没有 `succeeded` 的导入（试跑不算）。安装向导只在这时可用。
- "上一次导入"指最近一行 `succeeded` 且不是试跑的记录。导入提交前在报告里记下写进去的范围（`watermark`：各表最大的 id、角色和材质最晚的 `updated_at`），之后按它和 `finished_at` 判断新站有没有产生数据，不按导入的行自带的时间：旧站的时间可能在未来。

## 以下各表只定了要点，随对应切片细化

### 插件

- **plugins**：启用过的官方插件和已安装的插件，一个插件一行。官方插件第一次启用时才有这一行。列：
  - `id`（插件 id，主键）、`version`、`is_enabled`；
  - `capabilities`：管理员授予的能力，JSON。第一版安装时授予 manifest 申请的全部能力（ADR-0033）；
  - `package_hash`：安装插件存在存储接口里的插件包的 sha256，可空，官方插件为空。多实例部署时，各实例按它取包、校验（ADR-0033）；
  - `last_error`：最近一次启用或升级失败的原因，varchar(500)，可空。插件抛出的消息截到 500 字符，同 `jobs.last_error`；
  - 安装和更新时间。
- **plugin_kv**：`ctx.kv`。主键 `(plugin_id, key)`，`value` 是长文本 JSON，不超过 64 KB；`expires_at` 可空，建索引：读到过期的行当作不存在，定时任务清理；外键 → plugins，cascade。
- **plugin_migrations**：插件自有表的迁移记录。主键 `(plugin_id, name)`。
- 插件自有表的物理名是 `p_<id，连字符换成下划线>__<名字>`，例如 `p_invitation_codes__codes`，不能引用核心表（ADR-0010）。
- 插件的设置存在 `settings` 里，namespace 是 `plugin:<id>`。
- 卸载插件时删除它的表、KV、设置、迁移记录、还没完成的任务、定时任务条目、死信和存储里的插件包（ADR-0033）。

## 从 BS 导入

### 通用规则

- 只读旧库（ADR-0006）。按名字关联的查询（例如 UUID 映射）在旧库里执行，比较规则就和 BS 运行时一致：BS 可以运行在 MySQL / MariaDB、SQLite、PostgreSQL 上，各自的比较规则不同。
- 目标库在切换前只接受导入器写入。重跑导入用于最后一次同步，结果要与旧库当时的状态一致，包括旧库里删掉的数据。最后一次同步时旧站要停止服务，否则同步期间的写入可能只导入了一半。
- 时间按旧站的时区换算成 UTC（ADR-0015）。
- 开始前检查各表 id 的最大值，超过 2147483647 时停止（ADR-0015）。
- 遇到以下冲突时停止并列出，由服主在旧站处理后重跑，导入器不自动改名：
  - 转小写、去首尾空格后重复的邮箱；
  - `name_key` 重复的角色名；
  - 两个角色得到同一个 UUID。
- 引用了不存在的行的记录（BS 没有外键，删除用户、材质后会留下这类记录）按下面各表的规则跳过或置空，计入对账报告。
- 材质文件按原字节复制，不重新编码（不变量 3）。

### 运行

每次运行都从旧库重新导入全部数据，在一个目标库事务里先清空、再写入；有停止类问题、出错或被取消就整体回滚（ADR-0031）。

- **清空的范围**：所有业务数据，即用户（连同级联删除的账号、会话、角色、衣柜、令牌等）、材质、材质文件、举报、OAuth 客户端（公用应用这一行除外，它名下的令牌、同意记录和设备码照样清掉）、积分流水、审计日志、任务。保留 `settings` 里导入器不写的键、Better Auth 的 `jwks` 和 `oauth_resources`、`job_schedules`、`import_runs`、迁移记录。`texture_files` 最后处理：这次运行用到的行沿用或改写，用不到的删掉。
- **能不能写**：
  - 目标库没有业务数据（会被清空的表里一行都没有）：直接导入；
  - 有数据，并且来自上一次导入：命令行要加 `--replace`，网页上要勾选确认；
  - 上一次导入之后新站产生了数据，或者有数据却从没导入过：停止并列出，命令行再加 `--force`、网页上再勾选一次才继续。新站的数据指：会话、OAuth 令牌和授权、启动器令牌、不是"导入"的积分流水、审计记录；id 大于上一次导入范围的用户、角色、材质、举报、OAuth 客户端（公用应用由迁移插入，不算）；导入之后改过的角色和材质（`updated_at` 晚于导入范围）、加入的衣柜、处理过的举报；找回密码、两步验证、通行密钥、设备码，以及不是定时触发的后台任务。
- **指定 UUID**（`--uuid-overrides`，网页上在试跑报告的冲突旁边选择）：JSON 对象，键是 pid 的字符串，值是 UUID，带不带连字符、大小写都可以，导入时统一成 32 位小写十六进制。指定的值同样要通过"两个角色得到同一个 UUID"的检查。
- **像素 hash**：按上传的规则解码、规范化后计算（`@nextskin/skin`），文件不重新编码。规范化按引用这个文件的 `tid` 最小的材质的类型。能解码、但尺寸不合 NextSkin 规则的文件按解码出的原图计算，照样导入，在报告里列出。重跑时，上一次导入的 `texture_files` 里有同一 hash、同样大小的行，沿用它的像素 hash 和宽高。
- 材质文件在事务之外按 hash 复制进材质存储，存储里已经有、大小相同的不再复制。回滚后多出来的文件由 `core:texture-sweep` 回收（ADR-0029）。
- 沿用上一次的像素 hash 之前，按 PNG 头里的宽高和这次的类型算出规范化之后的宽高，与上一次的不同（tid 最小的材质换了类型）就重新解码。
- 回滚之后（试跑、停止、取消、出错）恢复 MySQL 的自增计数器（它不随事务回滚）；PostgreSQL 的序列只在确定提交时同步。

### 对照表

**users → users、accounts、score_transactions**

| BS | NextSkin | 规则 |
|---|---|---|
| uid | id | |
| email | email | 去首尾空格、转小写 |
| nickname | nickname | |
| score | score | 加上材质已不存在的待处理举报退还的花费（见 reports）。积分不为 0 时另写一条原因为"导入"的积分流水，余额等于导入的积分 |
| permission | role | -1 → `banned`，0 → `user`，1 → `admin`，2 → `superadmin`；其他值按 `user`，计入报告 |
| avatar | avatar_texture_id | 0、材质不存在或被跳过时为空 |
| locale | locale | BS 用下划线（`zh_CN`），换成连字符后对应到受支持的语言（`matchLocale`）；对应不上的置空 |
| ip | registration_ip | |
| last_sign_at | last_check_in_at | |
| — | email_version | 0：BS 的邮箱修改立即生效，没有待确认的链接（ADR-0024） |
| — | oauth_version | 0 |
| register_at | created_at、updated_at | |
| verified | email_verified | |
| password | accounts 里 `provider_id = 'credential'` 的一行 | `account_id` 写 uid 的字符串（Better Auth 按它找密码）。哈希登录成功后换成当前算法（ADR-0007）。BS 的算法和盐取决于旧站 `.env` 的 `PWD_METHOD` 和 `SALT`，导入命令要拿到这两项：bcrypt、argon2（`BCRYPT`、`ARGON2I`、`PHP_PASSWORD_HASH`）原样保存；十六进制摘要（`MD5`、`SALTED2SHA256` 等六种）存成 `$bs$<算法>$<小写摘要>`（`auth/legacy-passwords.ts` 的 `formatLegacyDigest`）。authme-integration 在 `SALTED2MD5`、`SALTED2SHA512` 下加的 `users.salt` 列非空时，盐和摘要拼成 `$authme$<算法>$<盐>$<小写摘要>`（`formatAuthmeSalted`），由官方插件"AuthMe 密码"核对。别的看起来像哈希的值（8 到 255 个可打印的 ASCII 字符，例如 AuthMe 的 `$SHA$…`）原样保存，留给 passwordHasher 插件认领（ADR-0033）；`$bs$`、`$authme$` 开头的不会来自 BS，不保存。认不出的哈希（空、长度与算法不符、带空白）不建这一行，用户可以找回密码；没有提供 `.env` 却遇到十六进制摘要时停止。`SALT` 是全站的 pepper，不进哈希，存进机密设置 `auth.legacyPasswordSalt` |

不导入：`is_dark_mode`、`verification_token`、`remember_token`。

**players → players**

| BS | NextSkin | 规则 |
|---|---|---|
| pid | id | |
| uid | user_id | 用户不存在时跳过这个角色 |
| name | name、name_key | |
| tid_skin、tid_cape | skin_texture_id、cape_texture_id | 小于等于 0、材质不存在或被跳过时为空 |
| last_modified | updated_at、created_at | BS 没有记录创建时间 |
| — | uuid | 见下文"UUID" |
| — | score_paid | 一律取旧站的 `score_per_player`：BS 删除任何角色都按现价退还，迁移前后删除角色退还的积分不变（ADR-0022） |

**textures → textures、texture_files**

| BS | NextSkin | 规则 |
|---|---|---|
| tid | id | |
| hash | hash | 每个不同的 hash 在 `texture_files` 里建一行：像素 hash 和宽高从文件解码得到，`size_bytes` 是文件大小，`ref_count` 是导入的条目里引用它的条数，`status` 为 `active`，`created_at` 是文件的修改时间 |
| name | name | |
| type | type | |
| uploader | uploader_id | 用户不存在时为空 |
| public | is_public | |
| upload_at | created_at、updated_at | |
| likes | likes | 不照搬，按导入后的衣柜重新统计。BS 的计数是先读再写回，可能有偏差，差异计入报告 |
| size | score_paid | `size_bytes` 直接取文件大小，不用这一列。`score_paid` = size（BS 存的是 KB）×（公开取旧站的 `score_per_storage`，私有取 `private_score_per_storage`）；公开材质在旧站开着 `take_back_scores_after_deletion` 时再减去 `score_award_per_texture`，不小于 0。这样迁移那一刻删除材质能退多少，迁移之后仍然是多少（ADR-0025） |

`type` 不是三种之一、`hash` 不是 64 位小写十六进制的材质跳过。文件缺失或无法解码的材质跳过：引用它的角色材质和头像置空，衣柜记录跳过，举报的 `texture_id` 置空。装过 texture-description 插件的站点，描述导入到 `description`。

**user_closet → closet_items**

| BS | NextSkin | 规则 |
|---|---|---|
| user_uid、texture_tid | user_id、texture_id | 表上没有主键，重复的行只留一条；用户或材质不存在时跳过 |
| item_name | name | 为空时用材质名 |
| — | score_paid | 一律取旧站的 `score_per_closet_item`：BS 移出任何一件都按它退还（ADR-0025） |
| — | created_at | BS 没有记录，取导入时刻 |

**reports → reports**

| BS | NextSkin | 规则 |
|---|---|---|
| id | id | |
| tid | texture_id | 材质不存在时为空 |
| uploader、reporter | uploader_id、reporter_id | 用户不存在时为空 |
| reason | reason | |
| status | status | 0 → `pending`，1 → `resolved`，2 → `rejected` |
| report_at | created_at | |
| — | score_paid | 状态是 `pending`、并且旧站 `reporter_score_modification` 为负时，取它的绝对值；其余为 0（ADR-0026） |

同一个人对同一个材质的重复举报（BS 先查后插，并发时会产生）只保留 id 最小的一条，其余计入报告。

材质已经不存在的待处理举报（包括文件缺失被跳过的材质）记为 `resolved`，`resolution` 是 `textureDeleted`，`resolver_id` 为空，`resolved_at` 取导入时刻。按上表算出的 `score_paid` 直接加回举报人导入的积分，然后记为 0。这样导入后，待处理的举报总是指向存在的材质（ADR-0027）。

**oauth_clients → oauth_clients**

| BS | NextSkin | 规则 |
|---|---|---|
| id | client_id | 转成字符串。第三方应用配置的 client_id 不用改 |
| secret | client_secret、token_endpoint_auth_method | Passport 按 secret 是否为空区分客户端：为空的是公共客户端，认证方式设为 `none`，换令牌时必须带 PKCE，与 Passport 相同。其他客户端的 secret 是明文，存成 sha256 的 base64url（与 `auth/auth.ts` 的 `storeClientSecret` 相同），认证方式设为 `client_secret_basic`。带 Janus 标记的应用不论有没有 secret 都转成公共客户端，见下 |
| name | name | |
| redirect | redirect_uris | 逗号分隔转成数组；去掉 Janus 标记 |
| user_id | user_id | |
| revoked | disabled | |
| created_at | created_at | |

- `personal_access_client` 或 `password_client` 为 1 的客户端不导入，这两种授权方式不再支持。
- 授权类型设为授权码和刷新令牌，与 Passport 对第三方应用开放的一致。
- **Janus 标记的公共客户端**（ADR-0037"导入器"）：BS 的 yggdrasil-connect 插件加外挂的 Janus 时，在回调地址里加一条路径以 `/yggc/client/public` 结尾的地址（只看路径，不看主机；末尾的 `/` 不算），这样的应用是给启动器用的公共客户端。导入时去掉标记地址和密钥，认证方式 `none`、`require_pkce`、`application_type: native`，授权方式加上设备码；去掉标记后没有回调地址的，授权方式只有刷新和设备码，`response_types` 为空。报告的 `oauthPublicClients` 逐个列出，原因码 `janus_public_client`。原来用密钥接入的网站要改成公共客户端的接法。
- Passport 的保密客户端在令牌端点既可以用 HTTP Basic 传 secret，也可以放在请求体里；Better Auth 只接受客户端登记的那一种。核心在请求进入 Better Auth 之前，把另一种方式改写成登记的方式（`auth/client-authentication.ts`），对所有保密客户端生效，所以导入时不用猜第三方应用用的是哪一种。

**options → settings**：只导入有对应设置项的键，对照表随设置注册表定。旧库里没有的选项按 BS 6.0.2 的默认值（`config/options.php`）算。值不合法的不导入、用 NextSkin 的默认值，超出设置项范围的取边界值，都在报告里列出。导入器写的键先全部删掉，再写入和默认值不同的（`packages/importer/src/settings.ts` 的 `IMPORTED_SETTING_KEYS`）。已经有的项：

| BS | NextSkin | 规则 |
|---|---|---|
| site_url | site.url | 安装向导确认的站点地址、命令行的 `--site-url` 优先 |
| site_name | site.name | |
| —（`config/app.php` 的时区） | site.timeZone | 取导入时指定的时区，默认 `Asia/Shanghai` |
| cache_expire_time | cache.publicMaxAge | 转成整数 |
| ygg_skin_domain | yggdrasil.skinDomains | 按逗号拆开，每项 trim，去掉空项 |
| ygg_search_profile_max | yggdrasil.profileSearchLimit | 转成整数 |
| ygg_enable_ali | yggdrasil.apiLocationIndication | `'true'` / `'false'` 转成布尔 |
| ygg_private_key | yggdrasil.signingKey | 机密项，原样加密保存；不是 4096 位以上的 RSA 私钥时不导入，报告里不写它的值 |
| ygg_token_expire_1 | yggdrasil.tokenValidSeconds | 转成整数 |
| ygg_token_expire_2 | yggdrasil.tokenRefreshableSeconds | 转成整数 |
| ygg_tokens_limit | yggdrasil.tokensPerUser | 转成整数 |
| ygg_rate_limit | yggdrasil.loginIntervalMs | 转成整数 |
| register_with_player_name | auth.registration.withPlayerName | 按 BS 的 `Option::get` 转成布尔：`'true'`、`'false'` 照字面，`''`、`'0'` 为假，其余为真 |
| require_verification | auth.requireEmailVerification | 同上 |
| regs_per_ip | auth.registration.perIpLimit | 转成整数 |
| user_initial_score | user.initialScore | 转成整数 |
| player_name_rule | player.nameRule | 取值相同 |
| custom_player_name_regexp | player.nameRegex | 规则同 `texture_name_regexp` |
| player_name_length_min、player_name_length_max | player.nameLength | 各自限制在 1–50 |
| ygg_uuid_algorithm | player.uuidAlgorithm | `v3` → `offline`，`v4` → `random`。决定以后新角色的 UUID 算法 |
| —（`.env` 的 SALT） | auth.legacyPasswordSalt | 机密项 |
| score_per_player | score.perPlayer | 转成整数 |
| return_score | score.refundOnDelete | `'true'` / `'false'` 转成布尔 |
| sign_score | checkIn.score | `'最小,最大'` 拆成 `{ min, max }` |
| sign_gap_time | checkIn.gapHours | 转成整数 |
| sign_after_zero | checkIn.resetAtMidnight | `'true'` / `'false'` 转成布尔 |
| score_per_storage | score.perKbPublic | BS 的默认值是字符串 `'true'`，`option()` 把它读成 true，乘法里当 1 用。所以 `'true'` → 1，`'false'` → 0，其余转成整数 |
| private_score_per_storage | score.perKbPrivate | 转成整数 |
| score_per_closet_item | score.perClosetItem | 转成整数 |
| max_upload_file_size | texture.maxFileSizeKb | 转成整数；超出 1–8192 时取边界值，在报告里注明 |
| texture_name_regexp | texture.nameRegex | 去掉 PCRE 的分隔符；修饰符 i、m、s 转成 `(?ims:…)`，u 本来就开着；带了其他修饰符、或者 JS 编译不了时，停止并报告 |
| reporter_score_modification | report.cost、report.reward | 为负时取绝对值，作为 `report.cost`；为正时加进 `report.reward`：BS 提交就发、驳回时收回，这里改成采纳时才发（ADR-0026） |
| reporter_reward_score | report.reward | 转成整数，与上一行的正值相加 |
| announcement_{语言}、announcement | site.announcement | 取与 `site.locale` 对应的那份（`zh-CN` 对应 `announcement_zh_CN`），没有就取不带后缀的；其余语言的版本在报告里列出。等于 BS 的默认公告（`Welcome to Blessing Skin {version}!`）时不导入。含原始 HTML 的在报告里注明：导入后这部分不再显示（ADR-0028）。超过 20000 个字符时停止并报告 |
| content_policy_{语言}、content_policy | texture.contentPolicy | 规则同上一行，没有默认文案 |
| site_description_{语言}、site_description | site.description | 取与 `site.locale` 对应的那份，没有就取不带后缀的，同公告。等于 BS 的默认值时不导入；超过 200 个字符时截断，在报告里注明（ADR-0032） |
| meta_keywords | site.keywords | 按半角和全角逗号拆开，每项 trim，去掉空项 |

下面这些设置不导入，不是默认值时在对账报告里列出来：`score_award_per_texture`、`take_back_scores_after_deletion`、`score_award_per_like`（不做奖励，ADR-0025、ADR-0026），`status_code_for_private`、`auto_del_invalid_texture`、`allow_downloading_texture`（ADR-0025）；`meta_description`（meta description 就是站点描述，与 `site_description` 不同时列出原文）、`copyright_text`（原始 HTML，列出原文，请站长改写成 Markdown 填进 `site.footer`）、`home_pic_url`、`favicon_url`、`meta_extras`、`copyright_prefer`、`fixed_bg`、`transparent_navbar`、`hide_intro`、`navbar_color`、`sidebar_color`、`custom_css`、`custom_js`（ADR-0032）。

### UUID

后果最严重的一项，对账报告要单独列出每个角色的 UUID 来源。

1. 对每个角色收集候选值，`uuid` 表存在时：
   - 按 pid：`uuid.pid = players.pid`，表上有 `pid` 列时才查；
   - 按名字：在旧库里用 `uuid.name = players.name` 关联，与 yggdrasil-api 运行时的查找方式相同，比较规则由旧库决定（MySQL 上忽略大小写）。

   两类都要查，不能按表结构二选一：`yggc:fix-uuid-table` 加的 `pid` 列是可空的，之后如果又换回 yggdrasil-api，它插入的新行只有名字、没有 pid。只按 pid 查，这些角色会被当成"从未分配"，重新生成 UUID。
2. 候选值统一成 32 位小写十六进制（旧版本可能存了带连字符的格式，只接受 8-4-4-4-12 的标准写法），再去重：
   - 只有一个值：就用它；
   - 有多个不同的值（同一个名字有几行、UUID 各不相同，或者按 pid 和按名字查到的不一样）：停止并报告，列出每个候选值的来源和行 id，由服主指定。导入器不替服主猜：BS 查找时用的 `first()` 没有排序，返回哪一行取决于数据库。MySQL InnoDB 上实际是 id 最小的一行，报告里可以注明这一点；PostgreSQL 上则不一定；
   - 没有候选值：这个角色从来没有被 Yggdrasil 查询过，BS 还没给它分配。按旧站的 `ygg_uuid_algorithm` 生成：`v3` 算离线 UUID，与 BS 将来会分配的相同；`v4` 随机生成，反正还没有游戏服务器见过它。
3. 候选值不是合法的 UUID：停止并报告。
4. 两个角色得到同一个 UUID：停止并报告。例外是生成的 UUID（离线算法、随机）：它还没有游戏服务器见过，与映射表里的或指定的值冲突时，生成的那个改用随机 UUID（与 ADR-0015 创建角色时的规则相同），不论两个角色的先后。
5. 服主处理冲突有两种方式：在旧站修正 `uuid` 表，或者给导入命令传一个文件，逐个指定角色的 UUID。
6. 没有对应角色的映射行（改名或删除角色后留下的）不导入，只在报告里记数。
7. 映射行里的名字与角色当前的名字不完全相同（例如只改了大小写，按 MySQL 的比较仍然关联得上）：仍然用表里存的值，在报告里单独列出。yggdrasil-connect 在离线算法下每次读取映射时，发现名字不一致就按当前名字重算 UUID，先写回表里再返回，所以正常情况下表里存的就是最近一次发给游戏服务器的 UUID。BS 继续运行的话，下一次读取会把它换掉，NextSkin 不换（ADR-0015）。例外是写回与 `yggc:fix-uuid-table` 并发等极端交错：写回没有改到任何行，内存里重算出的 UUID 却已经发了出去。所以运行修复命令和最终同步时，旧站要停止服务；已经出过这类问题的站点，用指定文件逐个纠正。

### 不导入的数据

| BS 的表或数据 | 原因 |
|---|---|
| jobs、migrations | 运行时数据 |
| language_lines | 后台改过的界面翻译。新界面的文案重新写过，键名对不上 |
| notifications | 站内信。ADR-0006 没有要求保留；读过的在 BS 里本来也看不到（ADR-0052） |
| oauth_access_tokens、oauth_auth_codes、oauth_refresh_tokens、oauth_personal_access_clients | 旧令牌全部作废（ADR-0001） |
| scopes | OAuth scope 由核心定义 |
| ygg_log | Yggdrasil 的操作日志 |
| code_id_to_uuid | yggdrasil-connect 授权码的中间状态 |
| Yggdrasil 令牌 | 存在 BS 的缓存里，不在数据库。迁移后启动器都要重新登录 |

## 落地顺序

| 切片 | 新建的表 |
|---|---|
| 只读协议端点（第 3 步） | users（Better Auth 的字段先建好，此时还不接 Better Auth）、texture_files、textures、users.avatar_texture_id、players、settings |
| 认证 | Better Auth 的其余各表、device_code_selections |
| 后台任务和积分 | jobs、failed_jobs、score_transactions |
| 用户中心和角色管理 | players.score_paid（加列） |
| 个人资料和账号安全 | users.email_version（加列） |
| 材质上传和皮肤库 | textures.score_paid（加列）、closet_items |
| 衣柜、换材质和举报 | reports |
| 后台和审计日志 | audit_logs |
| 定时任务 | job_schedules |
| Yggdrasil | yggdrasil_tokens |
| 导入器 | import_runs |
| 首页 | closet_items 的 created_at 索引 |
| 插件 | plugins、plugin_kv、plugin_migrations |
| Yggdrasil Connect 设备码流程 | oauth_clients 的公用应用（插入数据）、reference_id 的索引、users.oauth_version（加列） |
| 通知 | notifications、notification_broadcasts、plugin_notification_keys |

在第一个切片之前，`packages/db` 先补上 ADR-0015"后果"一节列出的辅助函数。
