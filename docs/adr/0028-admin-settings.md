# ADR-0028 后台设置页：表单由设置注册表生成，只有超级管理员能改设置；公告和内容政策按 Markdown 渲染，不渲染原始 HTML

- 状态：已采纳（验证码的分区、测试验证码和配置检查由 ADR-0038 补充；设置表单的图片控件由 ADR-0042 补充；不进设置表单、由主题页管理的主题设置项由 ADR-0057 补充）
- 日期：2026-10-18

## 背景

设置注册表（`packages/domain/src/settings/registry.ts`）里已经有 37 项，但除了直接改数据库，没有办法修改它们。站点地址、邮件、Yggdrasil 签名私钥都没有界面，服主自己部署之后无从配置。

已经定下的：
- AGENTS.md：新设置项只在注册表里声明类型和默认值，后台表单自动生成，不手写表单。
- ADR-0011 和 SDK：插件的设置页也根据设置 schema 自动生成，manifest 里存的是 JSON Schema；字段文案按约定取 `settings.<key>.label`、`settings.<key>.help`；`secret()` 标记的值永远不回传到浏览器。
- ADR-0022、ADR-0025 把公告和内容政策（BS 的 `content_policy`）留给了设置页；ADR-0027 把设置页留到了后面。
- ADR-0019：站点名、公告这类管理员填写的内容只有一种语言。

读取的现状：
- 每次请求都从数据库读（`settings.read`），没有缓存。认证实例在站点地址或站点名变化时重建（`auth/service.ts`），签名密钥在 PEM 变化时重新解析。所以设置改了立即生效，不用重启。
- 读出的值要通过 schema 校验，通不过就抛错。

BS 6.0.2 的做法：
- 后台有四个设置页：个性化、积分、站点配置、资源。管理员都能改，不只是超级管理员。
- 每个页面用 `OptionForm` 手写表单。
- 公告和内容政策按语言分别存（`announcement_zh_CN`，没有就用 `announcement`），用 GitHub 风格的 Markdown 渲染，允许原始 HTML。公告显示在用户中心的仪表盘，内容政策显示在上传页。
- 邮件配置在 `.env` 里，后台改不了。
- 改设置没有记录。

## 决定

### 范围

这次做：
- 设置的写入用例和审计记录；
- 设置页 `/admin/settings`：后台列出除内部项以外的全部核心设置，表单由注册表生成；
- 新设置项：公告、内容政策，以及渲染它们的 Markdown 组件；
- 生成 Yggdrasil 签名密钥；
- 发送测试邮件；
- 概览页的配置检查。

不做，留给后面的切片：
- 插件的设置页：随插件运行时做，复用这次的表单生成；
- BS 个性化页里的首页图、版权文字和站点描述，以及 SEO（`meta_*`），随首页做；导航栏和侧栏的配色不沿用，配色由 DESIGN.md 定；
- 自定义 CSS 和 JavaScript：ADR-0010 定的是改成核心中受管控的"统计/广告脚本"设置项，另定；
- reCAPTCHA：随验证码做；
- 首次启动时自动生成签名密钥：安装向导和启动器都还没有，随它们做；
- 全站公告条（DESIGN.md 的 Notice）：BS 的公告是长文，放在仪表盘上。短的全站提示以后需要时再做。

### 权限

新增具名权限 `settings.manage`：查看和修改站点设置、发送测试邮件。**只给超级管理员**：

| 权限 | 能做什么 | admin | superadmin |
|---|---|---|---|
| `settings.manage` | 查看和修改站点设置，发送测试邮件 | | ✓ |

BS 的管理员都能改设置，这里不沿用：
- 能改站点地址的人，能让找回密码邮件里的链接指向自己的域名；能改 SMTP 服务器的人，能让这些邮件经过自己的服务器。两样都能用来接管超级管理员的账号；
- 能改 `network.trustedProxies` 的人，能伪造客户端 IP，绕过注册的 IP 限制和按 IP 的限流；
- ADR-0027 定了管理员动不了超级管理员。把设置交给管理员，这条规则就不成立了。

以后要让管理员代管公告，就把公告拆成单独的权限。

检查方式同 ADR-0027：锁住自己的行之后，按事务里读到的角色判断。

### 注册表加的字段

每一项除了 `schema`、`default`、`secret`，再声明：
- **`section`**：在设置页的哪个分区显示，必填，所以新加的设置项不会漏掉。`null` 表示内部项，不在后台显示。现在只有 `auth.legacyPasswordSalt` 是内部项：它是导入时写入的旧站 `SALT`，改了之后旧密码就都对不上了。
- **`check`**，可选：只在写入时做的检查。
  - `player.nameRegex`、`texture.nameRegex`：带 `u` 标志能编译成正则；
  - `yggdrasil.signingKey`：为空，或者是 4096 位以上的 RSA 私钥（`parseSigningKey`）。

  这些检查不写进 schema：读取时也要过 schema，库里已经有的旧值（例如导入的）通不过，读这一项的页面就全挂了。运行时对这些值已经有兜底：正则编译不了返回 `player_name_rule_misconfigured`，密钥坏了返回协议规定的错误。
- **`generate`**，可选：由服务端生成新值的函数。表单在这一项旁边加"生成"按钮。现在只有 `yggdrasil.signingKey` 有，见"生成签名密钥"。

分区：

| 分区 | 设置项 |
|---|---|
| `site` 站点 | `site.name`、`site.url`、`site.locale`、`site.timeZone`、`site.announcement` |
| `registration` 注册 | `auth.registration.enabled`、`auth.registration.withPlayerName`、`auth.registration.perIpLimit`、`auth.registration.emailDomains`、`auth.requireEmailVerification` |
| `score` 积分 | `user.initialScore`、`score.perPlayer`、`score.perKbPublic`、`score.perKbPrivate`、`score.perClosetItem`、`score.refundOnDelete`、`checkIn.score`、`checkIn.gapHours`、`checkIn.resetAtMidnight`、`report.cost`、`report.reward` |
| `content` 角色和材质 | `player.nameRule`、`player.nameRegex`、`player.nameLength`、`player.uuidAlgorithm`、`texture.maxFileSizeKb`、`texture.nameRegex`、`texture.contentPolicy` |
| `mail` 邮件 | `mail.transport`、`mail.smtp`、`mail.smtp.password`、`mail.from` |
| `yggdrasil` Yggdrasil | `yggdrasil.signingKey`、`yggdrasil.skinDomains`、`yggdrasil.profileSearchLimit`、`yggdrasil.apiLocationIndication` |
| `advanced` 高级 | `network.trustedProxies`、`cache.publicMaxAge` |

### 表单从注册表生成

- 服务端把每一项的 schema 转成 JSON Schema（zod 的 `toJSONSchema`，取输入类型），和插件 manifest 里的设置 schema 是同一种形式。表单只认 JSON Schema，插件的设置页以后复用同一套。
- 按 JSON Schema 选控件：

| JSON Schema | 控件 |
|---|---|
| `boolean` | Checkbox：要点"保存"才生效（DESIGN.md） |
| `integer`、`number` | Input，`type="number"`，带上下限 |
| `string` | Input；`contentMediaType` 是 `text/markdown` 的用 Textarea 加预览 |
| 空字符串或带格式的字符串（`site.url`、`mail.from` 的地址） | Input，`type` 按格式取 `url`、`email`，可以留空 |
| `enum` | Select |
| 字符串数组 | Textarea，一行一项；提交前去掉每行首尾的空白和空行 |
| 对象 | 每个属性一个控件，放在同一个 Field 组里 |
| 机密项（`writeOnly`） | 见下 |

  映射不了的类型由测试拦下（见"后果"），不在页面上兜底。
- 机密项在 JSON Schema 里标 `writeOnly`。SDK 的 `secret()` 现在写的是 `meta({ secret: true })`，插件运行时生成 manifest 时改成同一个标记。
- 文案放在 `admin.settings.fields` 下，按设置项的键嵌套：`<键>.label`、`<键>.help`；对象的属性是 `<键>.fields.<属性>.label`，枚举的选项是 `<键>.options.<值>`。和 SDK 约定的 `settings.<key>.label` 同形。插件的设置页落地时，`fields`、`options` 这两条按插件 API 变更的流程补进 SDK 的约定。
- 浏览器只做 JSON Schema 表达得了的约束校验：必填、范围、长度、格式。schema 里的 `refine`（例如 `checkIn.score` 的最小值不大于最大值）和 `check` 由服务端检查，通不过的项按设置项的键返回字段错误。

### 页面

- 地址是 `/admin/settings/{分区}`，用 Tabs 按地址切换。`/admin/settings` 跳到第一个分区。后台导航加一项"设置"，按 `settings.manage` 显示。没有这个权限的人访问设置页返回 404，同 ADR-0027 的其他后台页面。
- 每个分区一个表单、一个"保存"按钮。只提交改过的项。
- 说明文字写明会影响什么，特别是难以挽回的后果：
  - 站点地址：通行密钥绑定在原来的域名上，改了域名，已有的通行密钥都不能再用；
  - UUID 算法：只影响以后新建的角色，已有角色的 UUID 不变（不变量 2）；
  - 签名密钥：游戏服务器要重启，才会拿到新的公钥。
- 机密项：
  - 值不发到浏览器，只显示"已设置"或"未设置"（Badge）；
  - 输入框留空表示不改，"清除"按钮恢复成默认值；
  - SMTP 密码用密码框，签名密钥用 Textarea 粘贴 PEM，也可以点"生成"。

### 写入

- `PATCH /api/admin/settings`，`{ values: { <键>: <值> } }`，要有 `settings.manage`，响应 200，`{ updated: [<键>] }`。
- 用例 `admin.updateSettings`：
  1. 锁住自己的行，检查权限；
  2. 每一项过 schema 和 `check`，有一项通不过就整个请求都不写，按键返回 400 `invalid_request` 的字段错误。未知的键和内部项按请求无效处理；
  3. 和默认值相同的删掉这一行，其余的 upsert：表里只存和默认值不同的项（`docs/schema.md`）。机密项照旧加密；
  4. 值和改之前相同的项跳过，不写审计。
- 一次请求的改动在同一个事务里写入，要么都生效，要么都不生效。
- 同一项被两个人同时保存，以后提交的为准。设置很少改，能改的人只有一两个，不做乐观锁。

### 审计

| 动作 | 对象 | details |
|---|---|---|
| `setting.update` | `setting`，id 为 0 | `{ key, from, to }` |

- 一项一条，同 ADR-0027"改了几个对象就记几条"。
- `subject_id` 是非空的整数，设置项没有整数 id，一律记 0，键名放在 `details` 里。按对象筛选 `setting` 和 0，就是全部的设置改动。
- 机密项只记 `{ key, secret: true }`，不记值（不变量 11）。
- 公告和内容政策只记改前改后的长度：两份全文加起来，可能超过 MySQL `text` 列的 64 KB。
- 审计日志页上，对象一栏显示设置项的名字，链接到它所在的分区。

### 公告和内容政策

新设置项：

| 设置 | 默认 | 对应 BS | 显示在 |
|---|---|---|---|
| `site.announcement` | 空 | `announcement` | 用户中心的仪表盘，空的时候不显示 |
| `texture.contentPolicy` | 空 | `content_policy` | 上传页，空的时候不显示 |

- 都是 GitHub 风格的 Markdown，最多 20000 个字符，只有一种语言（ADR-0019）。
- **不渲染原始 HTML**，直接去掉。BS 允许原始 HTML，但允许它就得做 HTML 清洗，清洗漏一处就是 XSS，ADR-0025 不渲染材质描述也是这个理由。能写公告的虽然只有超级管理员，但公告给所有用户看，超级管理员的账号一旦被盗，公告就成了攻击所有人的跳板。
- 链接只允许 `http`、`https`、`mailto` 和站内路径，图片只允许 `http`、`https`。
- 用 `react-markdown` 加 `remark-gfm` 渲染：输出 React 元素，不经过 `dangerouslySetInnerHTML`，原始 HTML 用 `skipHtml` 去掉。元素的样式由新组件 Markdown 统一（见"组件"）。
- 编辑时可以预览，预览用同一个 Markdown 组件。
- 导入：
  - 取与 `site.locale` 对应的那份（`announcement_zh_CN`），没有就取不带后缀的那份；其余语言的版本在对账报告里列出；
  - BS 的默认公告（`Welcome to Blessing Skin {version}!`）不导入；
  - 含原始 HTML 的在对账报告里注明：导入后这部分不再显示；
  - 超过 20000 个字符的，停止并报告。

### 生成签名密钥

- `POST /api/admin/settings/{键}/generate`，要有 `settings.manage`。注册表里没有声明 `generate` 的键，返回 400 `invalid_request`。
- 签名密钥是 4096 位的 RSA 私钥，用 `crypto.generateKeyPair` 异步生成，不占主线程。
- 生成要一两秒，所以放在事务之外：先生成，再开事务写入并记审计。SQLite 的写锁是全局的，事务里不能等慢操作（ADR-0008）。
- 写入和 `PATCH` 走同一个用例。审计同其他机密项，不记值，记作 `{ key, secret: true, generated: true }`。
- 响应同 `PATCH`，新私钥不回传到浏览器。
- 已经有密钥时，先弹确认框写明后果：
  - 游戏服务器要重启才会拿到新的公钥，重启之前验不过新的签名，玩家的皮肤可能显示不出来；
  - 旧密钥不保留，生成之后不能撤销。

### 测试邮件

- `POST /api/admin/settings/mail/test`，要有 `settings.manage`：用已经保存的设置，给操作者自己的邮箱发一封测试邮件。
- 当场发送，不经过任务队列：要马上知道配置对不对。
- 发送成功返回 200。没有配置邮件返回 400 `mail_not_configured`。SMTP 报错返回 502 `mail_test_failed`，带上服务器返回的错误信息，截到 300 个字符，日志里不记。
- `packages/email` 加一个测试邮件的模板。
- 不写审计：它不改动任何东西。

### 概览的配置检查

有 `settings.manage` 的人在后台概览上会看到还没完成的配置，每条是一个 Alert，链接到对应的分区：
- 生产环境没有设置站点地址：登录和注册都不可用（`site_url_required`）；
- 没有配置邮件：找回密码、验证邮箱都不可用；
- 没有签名密钥：Yggdrasil 的接口不可用。

### 接口

都认会话 Cookie（ADR-0022），权限在用例里检查：

| 接口 | 请求 | 成功响应 |
|---|---|---|
| `PATCH /api/admin/settings` | `{ values }` | 200，`{ updated }` |
| `POST /api/admin/settings/{键}/generate` | — | 200，`{ updated }` |
| `POST /api/admin/settings/mail/test` | — | 200 |

新错误码：`mail_not_configured`（领域层已经有，这次接进 REST）、`mail_test_failed`。设置项的字段错误沿用 `invalid_request`。

### 组件

- **Markdown**：新组件，写进 `packages/ui`，配 story 和截图基线，补进 DESIGN.md 的组件清单。标题从所在区块的下一级开始；表格、代码块在自己的容器里横向滚动，页面本身不横向滚动。
- 其余复用现有组件：Tabs、Form、Field、Input、Textarea、Checkbox、Select、Badge、Alert、Button。

### 事件和插件 API

- 不加事件：插件只读自己的设置（`ctx.settings`），核心设置的改动现在没有订阅者。
- 插件 API 不变。

## 后果

- 新依赖 `react-markdown`、`remark-gfm`，纯 JS，装在 `packages/ui`。
- 不加迁移：`settings` 表不变，审计记录写进现有的 `audit_logs`。
- 注册表的每一项都要声明 `section`。AGENTS.md 里"新设置项"的步骤补上：在 i18n 里写标签和说明。测试守着：
  - 每个可见的设置项都能映射到控件，在 `zh-CN`、`en` 里都有标签；
  - 枚举的每个值都有选项文案，对象的每个属性都有标签。
- `docs/schema.md` 的导入对照补上 `announcement`、`content_policy` 两行，并把 `content_policy` 从"不导入"里去掉。
- 在四种数据库上做测试：
  - 和默认值相同的项删掉行，不同的写入；机密项加密存储，读回来一致；
  - 有一项通不过时，整个请求都不写入，也没有审计记录；
  - 管理员（不是超级管理员）调用写入、生成密钥和测试邮件，都返回 403；
  - 生成的签名密钥能通过 `parseSigningKey`，Yggdrasil 元数据随即返回新的公钥；
  - 审计记录里，机密项没有值，长文本只有长度。
- e2e：
  - 超级管理员改站点名，页头跟着变；
  - 超级管理员生成签名密钥，`/api/yggdrasil` 随即返回公钥；
  - 写一条含原始 HTML 的公告，仪表盘显示渲染后的 Markdown，HTML 被去掉；
  - 管理员的后台导航里没有"设置"，直接访问设置页返回 404。

## 考虑过的其他方案

- **照 BS，管理员都能改设置**：理由见"权限"。
- **每个分区手写表单（BS 的 `OptionForm`）**：AGENTS.md 已经定了自动生成。手写的表单会和注册表里的约束脱节，插件的设置页也必须自动生成。
- **在注册表里给每一项声明控件和约束（`{ input: 'number', min: 0 }`）**：约束要在 schema 之外再写一遍。插件 manifest 本来就用 JSON Schema，从它生成，核心和插件共用一套。
- **允许原始 HTML，再用清洗库清洗**：理由见"公告和内容政策"。
- **用 `marked` 这类输出 HTML 字符串的解析器**：要靠 `dangerouslySetInnerHTML`，安全取决于我们对原始 HTML 和链接的处理一处不漏。`react-markdown` 输出 React 元素，原始 HTML 和危险链接默认就不会变成标签和属性。
- **乐观锁：提交时带上读取时的版本，冲突返回 409**：理由见"写入"。
- **一次保存只记一条审计**：一项一条，审计日志页上直接看得出改了什么。
- **给审计的设置记录另开可空的 `subject_id`**：要改刚建好的 `audit_logs`，SQLite 改列要重建整张表；站点设置只有一份，记 0 就够了。
- **设置改动后发事件**：现在没有订阅者，需要时按插件 API 变更的流程加。
