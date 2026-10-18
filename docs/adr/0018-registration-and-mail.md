# ADR-0018 注册走领域用例，邮件在事务之外异步发送

- 状态：已采纳（react-email 一条已被 ADR-0020 取代，进程内的邮件队列一条已被 ADR-0021 取代，验证码由官方插件接一条已被 ADR-0033 取代）
- 日期：2026-10-18

## 背景

认证切片已经接入 Better Auth（ADR-0007），注册目前用的是它的 `/sign-up/email`：谁都能注册，没有站点规则，也不发邮件。接下来要补上 BS 的注册规则、邮箱验证和找回密码。

BS 6.0.2 的注册（`AuthController::handleRegister`）做了这些事：
- 校验邮箱（唯一）、密码（8 到 32 位）、验证码；
- 按"注册时填写角色名"（`register_with_player_name`，默认开）要求角色名或昵称；
- 检查同一 IP 已注册的账号数（`regs_per_ip`，默认 3）；
- 写入用户，昵称取角色名，积分取初始积分（`user_initial_score`，默认 1000）；
- 顺带创建角色，最后登录。

此外：
- "关闭注册"和"限制邮箱域名"在 BS 里是插件，ADR-0010 已决定并进核心；
- BS 的"必须验证邮箱"（`require_verification`）不禁止登录，只拦住角色管理、上传和修改材质、举报、OAuth 应用管理。

查 Better Auth 1.7 的源码，发现两个问题：
- **它的注册在一个事务里完成，发验证邮件的回调也在这个事务里调用**，默认还会等回调结束。SMTP 的网络往返会一直占着 SQLite 的全局写锁，期间全站的写操作都要排队（AGENTS.md 已知的坑）。
- **我们的写入加不进它的事务。** 建角色、记注册 IP、调插件拦截器都要在同一个事务里，但 Better Auth 的事务拿不到 Kysely 的事务对象。用我们自己的 `db` 另写，在 SQLite 上会等它的写锁，而它又在等我们，互相卡死。

## 决定

### 注册

- 注册是一个领域用例（ADR-0004），关掉 Better Auth 的邮箱注册（`emailAndPassword.disableSignUp`）。登录、会话、找回密码、邮箱验证、两步验证、通行密钥仍由 Better Auth 处理。
- 用例的步骤：
  1. 在事务外校验输入和站点规则；密码哈希也在事务外算，scrypt 很耗 CPU，不能占着写锁。
  2. 在一个事务里完成：
     - 插入用户和 `provider_id = 'credential'` 的账号行（时间和布尔值按 Better Auth 的格式，用 `packages/db` 的辅助函数写）；
     - 需要时创建角色，和以后的"新建角色"用例共用同一段逻辑（角色名规则、UUID）；
     - 调用 `user.register` 拦截器、写 `user.registered` 事件（插件运行时和 outbox 落地后接上，位置现在就留好）。
  3. 提交后，通过 Better Auth 创建会话（不自己写 sessions 表），再把验证邮件放进发送队列。
- 邮箱和角色名的唯一性由唯一索引保证，冲突时返回对应的错误。同一 IP 的注册数在事务里计数。并发请求可能略微超出上限，这个限制只为防滥用，可以接受。

### 注册规则

新设置项，默认值取 BS 6.0.2：

| 设置 | 默认 | 说明 |
|---|---|---|
| `auth.registration.enabled` | 开 | 原 disable-registration 插件 |
| `auth.registration.withPlayerName` | 开 | 注册时填写角色名，昵称取角色名；关闭时填昵称（1 到 255 个字符） |
| `auth.registration.perIpLimit` | 3 | 0 表示不限。BS 的 0 会挡掉所有注册，导入时换成"关闭注册" |
| `auth.registration.emailDomains` | 不限 | 允许名单或禁止名单，原 restricted-email-domains 插件 |
| `auth.requireEmailVerification` | 关 | 语义同 BS：可以登录，但角色管理、上传和修改材质、举报、OAuth 应用管理要先验证邮箱。各用例自己检查，不交给 Better Auth 同名的开关（那个开关会禁止登录） |
| `user.initialScore` | 1000 | |
| `player.nameRule` | official | official：`[A-Za-z0-9_]`；cjk：再加 `§` 和基本区汉字（U+4E00–U+9FFF）；utf8：不含空白；custom：管理员填的正则 |
| `player.nameLength` | 3–16 | 按字符（码位）计，与 BS 的 `mb_strlen` 相同 |

- 密码：8 到 128 位，注册和重设密码用同一个范围（Better Auth 的 `minPasswordLength`、`maxPasswordLength`）。BS 的上限 32 没有必要沿用。Better Auth 登录时只检查上限，所以从外部系统导入的短于 8 位的旧密码照样能登录；BS 自己的密码不超过 32 位，不会超出上限。
- 客户端 IP：不信任请求头里的地址，除非请求来自设置里信任的代理（原 trust-proxies 插件）。注册 IP 和 Better Auth 的限流、会话记录用同一个解析结果。
- 验证码这次不做。SDK 已有 CaptchaProvider，以后由官方插件接 Turnstile、hCaptcha、reCAPTCHA，BS 的 reCAPTCHA 设置导入到那个插件。在那之前，靠同 IP 注册上限、邮箱域名限制和 Better Auth 的限流挡滥用。

### 邮件

- 核心自带 SMTP 通道，用 nodemailer（纯 JS，符合 ADR-0008）；插件通过 MailTransportProvider 接云厂商的发信 API。
- 配置存在设置里，SMTP 密码是加密的设置项。没有配置邮件时：
  - 找回密码不可用，页面说明原因（与 BS 相同）；
  - 后台提示：开着"必须验证邮箱"却没有配置邮件，用户将无法验证。
- **发送永远不在数据库事务里，也不阻塞请求**：
  - 用例提交后、Better Auth 的回调（验证邮件、重设密码邮件）里，都只把邮件放进进程内的发送队列；
  - 队列限制并发，有超时，失败按退避重试几次；
  - 日志不写收件人、正文和凭据（不变量 11）；
  - 响应不取决于发送结果，这也让"找回密码"不会因为响应时间不同而泄露邮箱是否注册过。
- 队列不持久化：进程崩溃会丢掉还没发出的邮件，用户可以重新发送。以后和事件的 outbox 一起改成持久的。
- 邮件模板用 react-email（ADR-0012），颜色取 `theme.css` 的取值写成内联样式（邮件客户端不支持 CSS 变量），只用亮色。文案按收件人的语言，随国际化一起接入。

## 后果

- 注册不再经过 Better Auth，它的 `databaseHooks.user.create` 不会在注册时触发，以后不要往那里放注册逻辑。Better Auth 升级时，要核对 users、accounts 两张表的格式没变：schema 比对测试已经守着列，注册用例的测试再检查写入的值能被 Better Auth 正常读出、登录。
- 注册后的会话由 Better Auth 创建，Cookie 的设置和登录完全一致。
- BS 的设置项要在导入器里映射到上面这些新键（`regs_per_ip = 0` → 关闭注册；`custom_player_name_regexp` 是带分隔符的 PCRE，要转成 JS 正则，转不了的报告给管理员）。
- 管理员能看到发送失败的计数，但看不到失败的具体邮件。持久化的发送记录等 outbox 落地后再做。

## 考虑过的其他方案

- **继续用 Better Auth 的注册，规则放进它的钩子**：钩子在它的事务里运行，拿不到事务对象，建角色和记注册 IP 都写不进同一个事务；发邮件的回调也在事务里。
- **发邮件时直接 await**：SMTP 慢或者连不上时，注册和找回密码要等几秒到几十秒，还会占着 SQLite 的写锁。
- **现在就做持久化的邮件队列**：需要先有 outbox 和后台任务的基础设施。验证邮件和重设密码邮件都能重发，丢一封的代价很小，等 outbox 落地再一起做。
- **核心自带图片验证码**（BS 的做法）：对现在的机器人效果有限，图片验证码本身还有无障碍问题。交给验证码插件更好。
- **沿用 Better Auth 的 `requireEmailVerification`**：未验证就不能登录，比 BS 严格，从 BS 迁移过来的未验证用户会被挡在门外。
