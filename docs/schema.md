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

## 用户与认证

### users

Better Auth 的 user 模型加上我们的领域字段。领域字段都有默认值，不注册给 Better Auth。

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | 自增 | 主键 | 即 uid |
| nickname | varchar(255) | 非空 | Better Auth 的 `name` 字段 |
| email | varchar(255) | 非空，唯一 | 一律小写 |
| email_verified | BA 布尔 | 非空 | |
| image | text | 可空 | Better Auth 的字段，第三方登录会写入头像 URL；站内头像用 `avatar_texture_id` |
| two_factor_enabled | BA 布尔 | 可空 | 两步验证插件的字段 |
| created_at | BA 时间 | 非空 | 注册时间 |
| updated_at | BA 时间 | 非空 | |
| role | varchar(16) | 非空，默认 `user` | `banned`、`user`、`admin`、`superadmin` 之一，与 SDK 的 `UserRole` 相同 |
| score | integer | 非空，默认 0 | 只能原子增减，并同时写积分流水 |
| avatar_texture_id | integer | 可空；外键 → textures，set null | |
| locale | varchar(16) | 可空 | |
| registration_ip | varchar(45) | 可空 | 用于"同一 IP 注册数"限制 |
| last_check_in_at | 时间 | 可空 | 上次签到时间。签到用一条带条件的 UPDATE 同时改它和积分，保证一天只能签到一次 |

`users` 和 `textures` 互相引用，所以 `avatar_texture_id` 在建完 `textures` 之后再加。

### Better Auth 的其他表

字段由 Better Auth 决定，表名和列名按 ADR-0015 映射（`packages/domain/src/auth/naming.ts`），迁移 0007–0020。以 Better Auth 的 schema 比对测试（`auth/schema.db.test.ts`）为准：缺表、缺列、缺命名索引都算失败；类型警告不能超出 Better Auth 用自己的迁移建出的库（serial 主键下它对自己建的表也报类型警告）。

- 列类型：日期 `authDateType`，布尔 `authBooleanType`，JSON 和数组 `authJsonType`，需要索引、外键或限长的字符串 `authStringType`（SQLite 上是 `text`：Better Auth 在 SQLite 上只认这个类型名），其余字符串 `text`。可空性与 Better Auth 一致，不加数据库默认值和 CHECK：取值由 Better Auth 决定，升级时可能新增。
- 索引名按 Better Auth 的规则：`<表>_<列>_idx`、`<表>_<列>_uidx`。它会按名字核对多列的表级索引，名字不对就当作缺失。外键名按我们的规则 `<表>_<列>_fk`，删除行为照 Better Auth 的声明。
- `passkeys.credential_id` 长 1364：WebAuthn 的 credential ID 最长 1023 字节，base64url 编码后 1364 个字符。MySQL 上这一列用 ascii 字符集（`authStringType` 的 `ascii` 选项），否则超过单列索引 3072 字节的上限。`passkeys.counter` 与 Better Auth 一样是 `integer`，规范允许的值最大到 2^32 - 1，超过 2^31 - 1 的认证器注册会失败。

| 表 | 插件 | 备注 |
|---|---|---|
| sessions | 核心 | |
| accounts | 核心 | 密码存在这里：`provider_id = 'credential'` 的那一行 |
| verifications | 核心 | 找回密码等一次性令牌（邮箱验证用的是 JWT，不经过这张表） |
| jwks | jwt | ID 令牌的签名密钥 |
| oauth_clients、oauth_resources、oauth_client_resources | oauth-provider | |
| oauth_access_tokens、oauth_refresh_tokens | oauth-provider | 令牌按我们指定的 sha256 存储（ADR-0007） |
| oauth_consents | oauth-provider | Yggdrasil Connect 选择的角色存在 `reference_id`（`player:<pid>`） |
| oauth_client_assertions | oauth-provider | 只给 `private_key_jwt` 用，serial 下它的防重放不起作用，这种认证方式已关闭（ADR-0015）。表照建，Better Auth 的 schema 比对要求它存在 |
| device_codes | 设备授权 | |
| two_factors | 两步验证 | |
| passkeys | 通行密钥 | 来自单独的 `@better-auth/passkey` 包 |

### device_code_selections

Yggdrasil Connect 设备流里，用户在批准页上选择的角色（ADR-0007、S1）。随认证切片落地。

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| device_code | varchar(255) | 主键 | 按字符串记录，不按自增 id（S1 审核发现 7） |
| user_id | integer | 非空；外键 → users，cascade | 认领者 |
| player_id | integer | 非空；外键 → players，cascade | |
| created_at | 时间 | 非空 | |

令牌兑换或请求被拒绝后删除这一行。

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
- **标记回收**：`status = 'deleting' where hash = ? and ref_count = 0 and status = 'active'`。过期的认领（`pending` 超过租期）同样改成 `deleting`。
- **删除存储对象**：标记之后先等一段时间 D，留给"刚删掉又上传同一张图"的情况把这一行改回 `pending`。然后：
  1. 提交 `claim_id = 新值, delete_attempted_at = 当前时间, delete_confirmed_at = null where hash = ? and status = 'deleting' and status_changed_at < 当前时间 - D`，改到一行才继续；
  2. 删除对象，对象不存在也算成功。如果从第 1 步提交到发出请求已经过了 L 的一半（例如进程被挂起过），放弃这次尝试；
  3. 成功后提交 `delete_confirmed_at = 当前时间 where hash = ? and claim_id = ?`。
- **删行**：`delete where hash = ? and status = 'deleting' and delete_confirmed_at is not null and delete_attempted_at < 当前时间 - L`。这时最近一次删除尝试已经成功，更早的尝试也都已超过冷却期。
- **存储里有对象、表里没有行**：清理任务先插入一条 `deleting` 行来认领这个 hash，再按上面的流程删除；插入时发现已经有行，说明不是孤儿，跳过。修改时间的宽限期只用来挑选候选，不起互斥作用。
- **临时文件**：文件名里的 `claim_id` 已经不是任何 `pending` 行的当前认领、修改时间又早于租期的，直接删除。临时文件从不对外提供，删掉总是安全的；原上传者改名时发现临时文件没了，就让这次上传失败。
- 认领租期、D、L 的具体值随实现定。
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
| description | text | 可空 | 原 texture-description 插件的功能 |
| uploader_id | integer | 可空；外键 → users，set null | 上传者删除账号后，公开材质保留 |
| is_public | 开关 | 非空 | |
| likes | integer | 非空，默认 0 | 收藏数，即有多少个衣柜里有它（包括上传者自己的）。和 `closet_items` 的增删在同一事务里原子增减（不变量 5） |
| created_at | 时间 | 非空 | |
| updated_at | 时间 | 非空 | |

皮肤库列表的筛选和排序索引（公开、类型、最新、最热），在实现皮肤库时按实际的查询建。

### closet_items

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| user_id | integer | 主键第一列；外键 → users，cascade | |
| texture_id | integer | 主键第二列；外键 → textures，cascade | |
| name | text | 非空 | 用户给这件衣服起的名字 |
| created_at | 时间 | 非空 | |

删除用户时，用例先锁住这个用户的行（见开头的"加锁顺序"），再逐条移除衣柜并减少对应材质的收藏数，最后删用户。外键的 `cascade` 只是兜底，它不会更新收藏数。不先锁用户的行，就挡不住两步之间并发加进来的收藏：它会被级联删除，收藏数却不会扣回。

### reports

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | 自增 | 主键 | |
| texture_id | integer | 可空；外键 → textures，set null | 材质删除后保留举报记录 |
| uploader_id | integer | 可空；外键 → users，set null | 举报时材质的上传者 |
| reporter_id | integer | 可空；外键 → users，set null | |
| reason | 长文本 | 非空 | BS 的列是 `longtext`，没有长度限制。新举报的长度在领域层限制 |
| status | varchar(16) | 非空 | `pending`、`resolved`、`rejected` 之一 |
| resolution | varchar(32) | 可空 | 处理方式，取值与 SDK 事件 `report.resolved` 的 `action` 相同。导入的旧记录为空 |
| resolver_id | integer | 可空；外键 → users，set null | |
| created_at | 时间 | 非空 | |
| resolved_at | 时间 | 可空 | |

- `(reporter_id, texture_id)` 唯一：BS 不允许同一个人重复举报同一个材质，无论之前的举报处理与否；举报还会改积分，只靠"先查再插"在并发下会重复结算。用户或材质删除后这两列会被置空，三种数据库都把 NULL 视为互不相同，这些旧记录不会挡住任何新举报，这正是想要的。
- 另建 `(status, id)` 索引，供后台按状态列出举报。

## 积分

### score_transactions

SDK 的 `adjustScore` 要求"原子地增减积分并记流水"。

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | 自增 | 主键 | |
| user_id | integer | 非空；外键 → users，cascade | |
| delta | integer | 非空 | |
| balance | integer | 非空 | 变动后的余额 |
| reason | varchar(128) | 非空 | 原因的 i18n 键，例如签到、上传材质、导入 |
| subject_type | varchar(32) | 可空 | 关联对象，例如上传材质时是 `texture` |
| subject_id | integer | 可空 | 删除材质时，按这里找到当初扣了多少积分来退还 |
| created_at | 时间 | 非空 | |

另建 `(user_id, id)` 索引。改余额和写流水在同一事务里：先用 `score = score + ?` 原子更新（扣减时带上"余额足够"的条件），再读回余额写流水。

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
- 诊断包不导出载荷和 `last_error`。

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

## 以下各表只定了要点，随对应切片细化

### 定时任务

- **job_schedules**：随第一个定时任务落地。列：`name`（varchar(128)，主键）、`next_run_at`（时间）。执行器用条件 UPDATE 把 `next_run_at` 从旧值推到下一次，影响 1 行才入队，去重键用 `name`（ADR-0021）。

### 审计与通知

- **audit_logs**：管理操作、权限变更、敏感操作。列：操作者类型和 id、动作、对象类型和 id、详情（JSON）、IP、时间。对象和时间各建索引。日志里不能出现不变量 11 列出的内容。
- **notifications**：SDK 的 `notifications.send`。标题和正文存 i18n 键加参数，按收件人的语言渲染。列：`user_id`（cascade）、`title_key`、`body_key`、`params`（JSON）、`read_at`、`created_at`。

### Yggdrasil

- authserver 令牌（用户名密码换令牌）的表随 Yggdrasil 切片定。ADR-0007 把它和 OAuth 令牌体系是否统一留到了实现阶段。要点：
  - 令牌只存 sha256；
  - 绑定的角色被删除或转让后，令牌失效；
  - 每个用户的令牌数有上限（BS 的 `ygg_tokens_limit`）。
- 进服记录（serverId 对应哪个角色）只保留几十秒，放在缓存接口里，默认是进程内存，不建表。
- 签名私钥存在 `settings` 的机密项里。

### 插件

- **plugins**：已安装的插件。列：`id`（插件 id，主键）、`version`、`is_enabled`、`capabilities`（管理员授予的能力，JSON）、安装和更新时间。
- **plugin_kv**：`ctx.kv`。主键 `(plugin_id, key)`，`value` 是长文本 JSON；外键 → plugins，cascade。
- **plugin_migrations**：插件自有表的迁移记录。主键 `(plugin_id, name)`。
- 插件自有表的物理名是 `p_<id>__<名字>`，不能引用核心表（ADR-0010）。
- 插件的设置存在 `settings` 里，namespace 是 `plugin:<id>`。
- 卸载插件时删除它的表、KV、设置、迁移记录和还没完成的任务。

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

### 对照表

**users → users、accounts、score_transactions**

| BS | NextSkin | 规则 |
|---|---|---|
| uid | id | |
| email | email | 去首尾空格、转小写 |
| nickname | nickname | |
| score | score | 积分不为 0 时另写一条原因为"导入"的积分流水，余额等于导入的积分 |
| permission | role | -1 → `banned`，0 → `user`，1 → `admin`，2 → `superadmin` |
| avatar | avatar_texture_id | 0、材质不存在或被跳过时为空 |
| locale | locale | |
| ip | registration_ip | |
| last_sign_at | last_check_in_at | |
| register_at | created_at、updated_at | |
| verified | email_verified | |
| password | accounts 里 `provider_id = 'credential'` 的一行 | `account_id` 写 uid 的字符串（Better Auth 按它找密码）。哈希登录成功后换成当前算法（ADR-0007）。BS 的算法和盐取决于旧站 `.env` 的 `PWD_METHOD` 和 `SALT`，导入命令要拿到这两项：bcrypt、argon2（`BCRYPT`、`ARGON2I`、`PHP_PASSWORD_HASH`）原样保存；十六进制摘要（`MD5`、`SALTED2SHA256` 等六种）存成 `$bs$<算法>$<小写摘要>`（`auth/legacy-passwords.ts` 的 `formatLegacyDigest`）。`SALT` 是全站的 pepper，不进哈希，存进机密设置 `auth.legacyPasswordSalt` |

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
| size | — | 不导入。BS 存的是 KB，`size_bytes` 直接取文件大小 |

文件缺失或无法解码的材质跳过：引用它的角色材质和头像置空，衣柜记录跳过，举报的 `texture_id` 置空。装过 texture-description 插件的站点，描述导入到 `description`。

**user_closet → closet_items**

| BS | NextSkin | 规则 |
|---|---|---|
| user_uid、texture_tid | user_id、texture_id | 表上没有主键，重复的行只留一条；用户或材质不存在时跳过 |
| item_name | name | 为空时用材质名 |
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

同一个人对同一个材质的重复举报（BS 先查后插，并发时会产生）只保留 id 最小的一条，其余计入报告。

**oauth_clients → oauth_clients**

| BS | NextSkin | 规则 |
|---|---|---|
| id | client_id | 转成字符串。第三方应用配置的 client_id 不用改 |
| secret | client_secret、token_endpoint_auth_method | Passport 按 secret 是否为空区分客户端：为空的是公共客户端，认证方式设为 `none`，换令牌时必须带 PKCE，与 Passport 相同。其他客户端的 secret 是明文，存成 sha256 的 base64url（与 `auth/auth.ts` 的 `storeClientSecret` 相同），认证方式设为 `client_secret_basic` |
| name | name | |
| redirect | redirect_uris | 逗号分隔转成数组 |
| user_id | user_id | |
| revoked | disabled | |
| created_at | created_at | |

- `personal_access_client` 或 `password_client` 为 1 的客户端不导入，这两种授权方式不再支持。
- 授权类型设为授权码和刷新令牌，与 Passport 对第三方应用开放的一致。
- Passport 的保密客户端在令牌端点既可以用 HTTP Basic 传 secret，也可以放在请求体里；Better Auth 只接受客户端登记的那一种。核心在请求进入 Better Auth 之前，把另一种方式改写成登记的方式（`auth/client-authentication.ts`），对所有保密客户端生效，所以导入时不用猜第三方应用用的是哪一种。

**options → settings**：只导入有对应设置项的键，对照表随设置注册表定。`ygg_uuid_algorithm` 决定以后新角色的 UUID 算法。已经有的项：

| BS | NextSkin | 规则 |
|---|---|---|
| site_url | site.url | |
| site_name | site.name | |
| cache_expire_time | cache.publicMaxAge | 转成整数 |
| ygg_skin_domain | yggdrasil.skinDomains | 按逗号拆开，每项 trim，去掉空项 |
| ygg_search_profile_max | yggdrasil.profileSearchLimit | 转成整数 |
| ygg_enable_ali | yggdrasil.apiLocationIndication | `'true'` / `'false'` 转成布尔 |
| ygg_private_key | yggdrasil.signingKey | 机密项，原样加密保存 |

### UUID

后果最严重的一项，对账报告要单独列出每个角色的 UUID 来源。

1. 对每个角色收集候选值，`uuid` 表存在时：
   - 按 pid：`uuid.pid = players.pid`，表上有 `pid` 列时才查；
   - 按名字：在旧库里用 `uuid.name = players.name` 关联，与 yggdrasil-api 运行时的查找方式相同，比较规则由旧库决定（MySQL 上忽略大小写）。

   两类都要查，不能按表结构二选一：`yggc:fix-uuid-table` 加的 `pid` 列是可空的，之后如果又换回 yggdrasil-api，它插入的新行只有名字、没有 pid。只按 pid 查，这些角色会被当成"从未分配"，重新生成 UUID。
2. 候选值统一成 32 位小写十六进制（旧版本可能存了带连字符的格式），再去重：
   - 只有一个值：就用它；
   - 有多个不同的值（同一个名字有几行、UUID 各不相同，或者按 pid 和按名字查到的不一样）：停止并报告，列出每个候选值的来源和行 id，由服主指定。导入器不替服主猜：BS 查找时用的 `first()` 没有排序，返回哪一行取决于数据库。MySQL InnoDB 上实际是 id 最小的一行，报告里可以注明这一点；PostgreSQL 上则不一定；
   - 没有候选值：这个角色从来没有被 Yggdrasil 查询过，BS 还没给它分配。按旧站的 `ygg_uuid_algorithm` 生成：`v3` 算离线 UUID，与 BS 将来会分配的相同；`v4` 随机生成，反正还没有游戏服务器见过它。
3. 候选值不是合法的 UUID：停止并报告。
4. 两个角色得到同一个 UUID：停止并报告。
5. 服主处理冲突有两种方式：在旧站修正 `uuid` 表，或者给导入命令传一个文件，逐个指定角色的 UUID。
6. 没有对应角色的映射行（改名或删除角色后留下的）不导入，只在报告里记数。
7. 映射行里的名字与角色当前的名字不完全相同（例如只改了大小写，按 MySQL 的比较仍然关联得上）：仍然用表里存的值，在报告里单独列出。yggdrasil-connect 在离线算法下每次读取映射时，发现名字不一致就按当前名字重算 UUID，先写回表里再返回，所以正常情况下表里存的就是最近一次发给游戏服务器的 UUID。BS 继续运行的话，下一次读取会把它换掉，NextSkin 不换（ADR-0015）。例外是写回与 `yggc:fix-uuid-table` 并发等极端交错：写回没有改到任何行，内存里重算出的 UUID 却已经发了出去。所以运行修复命令和最终同步时，旧站要停止服务；已经出过这类问题的站点，用指定文件逐个纠正。

### 不导入的数据

| BS 的表或数据 | 原因 |
|---|---|
| jobs、migrations | 运行时数据 |
| language_lines | 后台改过的界面翻译。新界面的文案重新写过，键名对不上 |
| notifications | 站内信。ADR-0006 没有要求保留，需要时再补 |
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
| 材质上传、衣柜、举报 | closet_items、reports |
| 第一个管理操作 | audit_logs |
| 第一个定时任务 | job_schedules |
| Yggdrasil | authserver 令牌表 |
| 插件 | plugins、plugin_kv、plugin_migrations |
| 通知 | notifications |

在第一个切片之前，`packages/db` 先补上 ADR-0015"后果"一节列出的辅助函数。
