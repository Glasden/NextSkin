# ADR-0015 核心 schema 约定：时间存 ISO 字符串、角色名靠规范化列、UUID 绑定角色

- 状态：已采纳
- 日期：2026-10-17

## 背景

ADR-0006 决定使用新 schema，但还没有设计。逐表的设计见 `docs/schema.md`，这里只记录跨表的约定。这些约定一旦有了数据就很难再改。

四种数据库在三类值上的读写行为不一致（按 `packages/db` 当前使用的驱动）：

| | SQLite（node:sqlite） | MySQL / MariaDB（mysql2） | PostgreSQL（pg） |
|---|---|---|---|
| 日期时间列 | 没有这个类型，存字符串；本项目的方言拒绝写入 `Date` | 读出 `Date`；写入时按 mysql2 的 `timezone` 选项换算，默认是进程所在时区 | `timestamptz` 读出 `Date` |
| 布尔列 | 读出 `0` / `1` | `tinyint(1)` 读出 `0` / `1` | 读出 `true` / `false` |
| JSON 列 | 字符串 | MySQL 自动解析成对象；MariaDB 的 `json` 是 `longtext` 的别名，读出字符串 | 自动解析成对象 |
| `bigint` | `number` | `number`（超过 2^53 时丢失精度） | 字符串 |

Better Auth（ADR-0007）按我们要用的插件算一共 14 张表（核心 4 张，jwt、oauth-provider、设备授权、两步验证插件 10 张），列类型由它决定：在 MySQL 和 PG 上它读写 `Date`，在 SQLite 上存 ISO 字符串；它自己的迁移在 MySQL 上用 `timestamp(3)`，2038 年会溢出。

BS v6 的现状（从 6.0.2 实例导出的表结构和源码确认）：

- 没有外键，`users.email`、`players.name`、`textures.hash` 上也没有唯一约束，唯一性只靠应用层先查后插；
- 所有表用 `utf8mb4_unicode_ci`，角色名和邮箱的比较忽略大小写，也忽略重音；
- datetime 列存的是 `config/app.php` 里写死的时区（`Asia/Shanghai`）的本地时间；
- UUID 由插件管理。yggdrasil-api 按角色名在 `uuid` 表里查，第一次被查询时才分配，表上没有任何约束；yggdrasil-connect 改为按 pid 关联、加了唯一约束。两个插件在离线算法（`ygg_uuid_algorithm = v3`）下都会在角色改名时把 UUID 换成新名字的离线 UUID。

## 决定

### 命名与主键

- 表名用 snake_case 复数，列名用 snake_case。
- 实体表的主键都叫 `id`，用 `autoIncrementId` 生成整数自增。Better Auth 不允许用户表主键改名，其他表也跟着统一。对外 DTO 仍然叫 `uid`、`pid`、`tid`。
- 纯关联表（例如衣柜）用复合主键。
- 外键列叫 `<实体>_id`，例如 `user_id`、`skin_texture_id`。
- Better Auth 的表和字段通过它的 `modelName` / `fields` 配置映射成同样的风格，例如 `oauthAccessToken.expiresAt` 对应 `oauth_access_tokens.expires_at`。映射表由代码按规则从 Better Auth 的 schema 生成，不手写。
- 导入时保留 BS 的 `uid`、`pid`、`tid`，导入后对每张表调用 `syncAutoIncrement`。
- 主键用有符号 `integer`，上限 2147483647。BS 的这几列是 `int unsigned`，但引用它们的列（`players.uid`、`players.tid_skin`、`textures.uploader` 等）是有符号 `int`，超过这个值的 id 在 BS 里也引用不了。导入器先检查最大 id，超出时停止并报告。

### 时间：我们自己的列一律存 ISO 字符串

- 格式固定为 `Date#toISOString()` 的输出，UTC、毫秒精度，例如 `2026-10-17T08:00:00.000Z`，列类型 `varchar(24)`。
- 写入的值只能来自 `toISOString()`，用品牌类型在类型层面区分 ISO 时间和普通字符串；日期本身是否合法（例如月份）由应用校验。
- 列由 `packages/db` 的辅助函数定义，同时加一个 CHECK 约束兜底，逐位检查数字和固定字符、区分大小写。格式不统一时，字符串顺序就不再是时间顺序。`like` 做不到：`_` 匹配任意字符，SQLite 的 `like` 还不区分大小写。所以这个约束按方言写（SQLite 用 `glob`，其他三种用正则），封装在辅助函数里。
- 理由：
  - 四种数据库读出来都是同一个字符串，不经过任何驱动的时区换算；
  - 格式定长，字符串的大小顺序就是时间顺序，范围查询和排序都能用；
  - 与插件 SDK 的 `IsoDateTime` 相同，DTO 不用转换；
  - 服主用 phpMyAdmin 之类的工具也能直接看懂。
- 代价：SQL 里不能做日期运算（不变量 6 本来也不允许方言相关的写法）。"当前时间"一律由应用作为参数传入，测试时也更容易控制。
- **例外：Better Auth 声明的日期字段**按它的约定使用原生类型：MySQL 用 `datetime(3)`（不用它默认的 `timestamp(3)`，后者 2038 年溢出，而且会随会话时区换算），PG 用 `timestamptz(3)`，SQLite 用 Better Auth 自己的类型名 `date`（实际存的是 ISO 字符串）。为此 mysql2 必须设置 `timezone: 'Z'`，`packages/db` 现在没有设置。我们的代码需要直接读写这些列时（例如进服校验按令牌哈希查令牌表），用 `packages/db` 的辅助函数转换，不在业务代码里按方言分支。

### 布尔：不用 boolean 列

- 能用可空时间戳表达的状态就用时间戳，例如 `revoked_at`、`read_at`。
- 时间没有意义的开关用 `smallint` 存 0 / 1，加 CHECK 约束，TypeScript 类型写成 `0 | 1`，列名以 `is_` 开头。
- Better Auth 的布尔字段按它的约定（PG `boolean`，MySQL `tinyint(1)`，SQLite `integer`），由它自己转换。

### JSON：存成 text

- 列类型用 `text`，写入前 `JSON.stringify`，读出后用 zod 校验再使用。SQL 里不查询 JSON 内部的字段，需要查询的值单独成列。
- 可能超过 64 KB 的列（例如事件载荷，以及 BS 里本来就是 `longtext` 的列）用 `packages/db` 的辅助函数定义，MySQL 上是 `longtext`。MySQL 的 `text` 上限是 64 KB，其他数据库没有这个限制。
- Better Auth 的 `json` 和 `string[]` 字段按它的约定。

### 忽略大小写的唯一性：另存规范化的列

- 邮箱：Better Auth 在注册、登录、修改邮箱时都先转成小写，所以 `users.email` 直接存小写，唯一索引建在这一列上。我们自己写入邮箱的地方也必须转小写。
- 角色名：`players.name` 保留用户输入的大小写，用于显示；`players.name_key` 存 `name.toLowerCase()`，唯一索引建在 `name_key` 上。所有按名字查角色的地方（CSL、USM、Yggdrasil、用角色名登录）都查 `name_key`。
- **按名字查角色的协议端点，行为以 BS 跑在 MySQL 上为准**：忽略大小写。契约用例要覆盖大小写不同的请求。这比不变量 1 的字面要求窄，两处差异是有意接受的：
  - BS 在 MySQL 上靠 `utf8mb4_unicode_ci` 比较，它还忽略重音，例如 `Rene` 能查到 `René`。我们不复现，这样的请求从 200 变成 404。正版角色名只有 ASCII 字符，只有允许非 ASCII 角色名的站点受影响；
  - BS 跑在 SQLite 上时比较区分大小写，`alice` 查不到 `Alice`。导入后能查到，从 404 变成 200。
- 不用排序规则或扩展来做（MySQL 的 `_ci`、PG 的 `citext`、SQLite 的 `NOCASE`）：三者的规则各不相同，`citext` 还需要安装扩展。
- 三种数据库都把 NULL 视为互不相同，唯一索引只在所有列都非空时防重复。需要连 NULL 一起去重的列，不要设成可空。

### 外键：核心表之间都声明

- 每个外键都写明删除时的行为（`cascade`、`set null` 或 `restrict`），逐条定义在 `docs/schema.md`。
- 外键一律写成表级约束（Kysely 的 `addForeignKeyConstraint`），不用列定义里的 `.references()`：MySQL 8.4 会接受但忽略列定义里的 `REFERENCES`，建表和 `alter table … add column` 都是如此，外键悄无声息地不存在（已实测；MariaDB 10.11 会生效）。
- 给已有的表加外键列要用 `packages/db` 的辅助函数：SQLite 不支持 `alter table … add constraint`，只能在 `add column` 里内联；MySQL 只认单独的约束。
- 外键的删除行为只是兜底。删除时需要更新计数（例如收藏数）或发出事件的，由用例显式删除依赖的行，不依赖 `cascade`。
- PG 不会自动给外键列建索引，外键列要显式建索引；否则删除被引用的行时，要全表扫描引用它的表。
- 插件表不能引用核心表（ADR-0010）。
- BS 没有外键，导入时遇到引用了不存在的行的记录，按 `docs/schema.md` 的规则跳过或把引用置空，并计入对账报告。

### UUID 绑定角色，创建后不再改变

- `players.uuid` 是 32 位小写十六进制、不带连字符，非空、唯一，**在创建角色时就分配**，之后任何操作都不改它，包括改名和转让。
- 分配算法沿用 BS 的设置：离线算法（`md5("OfflinePlayer:" + name)` 再改写版本位，与离线模式服务器算出的 UUID 相同）或随机（v4）。离线算法算出的 UUID 已经被另一个角色占用时（例如原来用这个名字的角色改名后仍然保留着它），改用随机 UUID。
- 删除角色时，它的 UUID 随之释放。之后有人再创建同名角色，在离线算法下会得到同一个 UUID，与 BS 相同。
- **与 BS 的行为差异**：BS 在离线算法下，角色改名后 UUID 跟着名字变。我们按不变量 2 不改，游戏服务器上这个玩家的数据不会因为改名而对不上；代价是改名后的 UUID 不再等于新名字的离线 UUID。

### 材质文件与材质条目分开

- `texture_files` 一个文件一行，以 hash 为主键，记录像素 hash、宽高和字节数。`textures` 是材质库里的条目，多个条目可以指向同一个文件：BS 允许不同用户各自上传同一张图的私有副本。
- 上传时按像素 hash 查重。已经有像素相同的文件时（包括导入的旧文件），新条目直接指向那个文件和它的 hash，不再另存一份。
- 一个文件不再被任何条目引用后，由后台任务删除。删文件发生在事务提交之后，外键的 `restrict` 只能保护数据库里的行，保护不了存储里的文件：回收任务删完行之后、删文件之前，同一个 hash 的上传可能已经重新建了行。所以文件行带引用计数和"上传中""删除中"两个中间状态：动存储里的对象之前，先在表里认领这一行，之后每一步都凭认领标识做带条件的 UPDATE。远程存储的删除请求超时后仍可能执行，所以"删除中"的行要在最近一次删除尝试之后保留一个冷却期，期间没有人能在这个 hash 上写新对象。流程见 `docs/schema.md`。

### Better Auth 的表由我们的迁移创建

- 不用 Better Auth 自带的迁移：它在运行时比对数据库并直接改表，没有版本记录，也不会加 MySQL 的表选项（`createTable`）。
- 四库测试用 Better Auth 自己的 schema 比对，确认我们的迁移结果符合它的期望。升级 Better Auth 时，靠这个测试发现新增或改动的字段。它对缺表、缺列给出迁移，对列类型不符只打警告，所以测试还要把类型警告当作失败。
- 用户表必须是 Better Auth 的 user 模型。我们的领域字段（角色、积分、头像、语言等）直接加在 `users` 上，都有默认值，不注册给 Better Auth，它插入用户时不写这些列。
- **对 ADR-0007 的补充**：`generateId: 'serial'` 下，Better Auth 的"单次使用"检查不生效。它靠"用被保护的值算出确定的主键，重复插入就冲突"来防重放，serial 模式会把这个主键换成数据库自增的数字（Better Auth 源码里有对应的警告）。审核用 Better Auth 1.7.10 的真实代码在四种数据库上复现过：同一个值提交两次，两次都被接受。整数 uid 是必须保留的，serial 不能放弃，所以认证切片要把受影响的能力全部关掉，并写请求级的测试守住：
  - **DPoP**：默认就接受请求里带的 DPoP proof，即使客户端没有要求绑定，也没有开关。审核实测，配置 `dpop: { signingAlgorithms: [] }` 后请求会被拒绝（`invalid_dpop_proof`）；
  - **`private_key_jwt`**：它固定在支持的认证方式列表里，不能靠配置去掉。要在创建、修改客户端的入口拒绝这种认证方式，并在令牌端点拒绝 `client_assertion`；
  - 依赖同一机制（`reserveVerificationValue`）的插件不启用：magic-link、email-otp、SIWE。找回密码用的是 `consumeVerificationValue`，审核在四种数据库上实测过它只接受一次，不受影响。

### 其他

- 不做软删除。删除就是从表里删掉，需要留痕的操作写进审计日志。
- 导入时，BS 的 datetime 按旧站的时区换算成 UTC。时区默认 `Asia/Shanghai`，可以用命令行参数覆盖，服主改过 `config/app.php` 时需要指定。

## 后果

- `packages/db` 要先补上，每一项都配四库测试：
  - ISO 时间列、`0 | 1` 开关列、长文本列的定义函数；
  - 给已有的表加外键列的函数；
  - Better Auth 日期列的读写转换；
  - mysql2 的 `timezone: 'Z'`。
- lint 规则 `no-dialect-specific-sql` 要扩展：`packages/db` 以外不允许列级 `.references()`。
- 认证切片要做到：关掉受 serial 影响的能力（见上文"对 ADR-0007 的补充"）；导入的 OAuth 客户端能按原来的方式认证（见 `docs/schema.md` 的导入对照）。
- 插件 SDK 要改，属于插件 API 变更，需要附 changeset：
  - `Texture.uploader` 改为可空：上传者删除账号后，公开材质仍然保留；
  - `TexturesApi.findByHash` 要重新定义返回哪一条，因为 hash 在 `textures` 上不唯一。
- 迁移指南里要写明：
  - 改名不再换 UUID；
  - 按名字查角色只忽略大小写，不再忽略重音；
  - BS 的 Yggdrasil 令牌存在缓存里，导入不了，迁移后所有启动器都要重新登录；
  - OAuth 令牌按 ADR-0001 全部作废。
- Better Auth 的表和我们的表在时间、布尔的存储方式上不同。业务代码一般不直接查 Better Auth 的表；确实要查时，用 `packages/db` 的转换函数。

## 考虑过的其他方案

- **时间用原生类型**（MySQL `datetime(3)`、PG `timestamptz`、SQLite 字符串）：读出来在 MySQL 和 PG 上是 `Date`、在 SQLite 上是字符串，每个日期列在仓储层都要转换。写入时 SQLite 不接受 `Date`，MySQL 和 MariaDB 不接受以 `Z` 结尾的 ISO 字符串，也要按方言转换。
- **时间存 epoch 毫秒**（`bigint`）：PG 的 `int8` 会被 pg 读成字符串，需要改全局类型解析；服主直接看数据库时看不懂。
- **领域字段放进单独的 `user_profiles` 表**：Better Auth 的表里只有它自己的字段，更整洁；但几乎每个请求都要取用户的角色，等于每次多一次查询或连接。
- **改名时按离线算法换 UUID（BS 的做法）**：违反不变量 2。
- **UUID 像 yggdrasil-api 那样按名字惰性分配**：在第一次分配之前 UUID 不确定，也就谈不上"不变"；按名字关联还会让改名、删除后重建的语义变得混乱。
