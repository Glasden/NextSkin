# ADR-0052 通知：每个收件人一行，群发由后台任务分批展开；系统通知存类型和参数、按收件人的语言渲染；插件经 `notifications.send` 发通知

- 状态：已采纳
- 日期：2026-10-22
- 补充 ADR-0019："邮件和站内通知"一节落到站内通知上
- 补充 ADR-0026：新举报通知管理员
- 补充 ADR-0027：新增具名权限 `notifications.send`
- 补充 ADR-0029：新增定时任务 `core:notification-sweep`
- 补充 ADR-0036、ADR-0037：发"管理员修改了你的账号"邮件的那些操作，另发一条站内通知
- 补充 ADR-0041：第二项写核心数据的能力 `notifications.send`；幂等键不和写入记在同一行

## 背景

BS v6 只有一种通知：管理员在后台概览的表单里写标题（不超过 20 个字符）和 Markdown 正文，收件人四选一（全部用户、普通用户、指定 uid、指定邮箱），发送时经队列给每个收件人写一行（Laravel 的 `notifications` 表，`data` 是 `{title, content}`）。页头的下拉只列未读，点开一条弹框显示正文、同时标为已读；读过的再也看不到，没有历史，也不能删。插件用 `Hook::sendNotification` 发，存法相同。另有 OAuth scope `Notification.Read`、`Notification.ReadWrite` 和对应的 REST 接口，属于 BS 的 Passport API，NextSkin 不复刻（ADR-0001）。

NextSkin 一直把通知列在"还没做"里，几处都在等它：

- `docs/schema.md` 只定了要点：标题和正文存 i18n 键加参数，按收件人的语言渲染（ADR-0019）；
- ADR-0026：新举报"通知管理员要等站内信落地"；
- ADR-0036、ADR-0037：后台改账号、改角色、停用和删除 OAuth 应用时给用户发邮件，没有配置邮件的站点什么都不发；
- ADR-0041：`notifications.send` 列在"以后的写能力"里，要另写 ADR；
- 举报的处理结果、材质被管理员下架或删除，用户现在只能自己去页面上看。

约束：

- SQLite 的写锁是全局的（ADR-0008）。给几万、几十万用户群发，在一个事务里写完会让全站的写入排队。
- 页头在布局里，客户端导航时布局不重新渲染，服务端渲染的未读数会过时。
- 插件 API 是 semver 契约，SDK 还在候选期（ADR-0035）。

## 决定

### 三种通知

| 来源 | 存什么 | 怎么显示 |
|---|---|---|
| 系统通知（核心） | 类型和参数 | `packages/i18n` 里 `notifications.types.<类型>` 下的标题和正文，按收件人的语言渲染；链接由类型决定 |
| 管理员写的 | 标题和正文的原文，一次发送存一份 | 正文是 Markdown，用组件 Markdown 渲染（不渲染原始 HTML，ADR-0028） |
| 插件发的 | 插件的文案键、参数和站内链接 | 用插件的文案按收件人的语言渲染；插件卸载、还没清理掉时显示兜底文案 |

收件人的语言照 ADR-0019：`users.locale`，没有时用站点默认语言。读的时候渲染，用户改了语言，旧通知跟着变。

### 表

**notifications**：一个收件人一行。

| 列 | 类型 | 说明 |
|---|---|---|
| id | 自增主键 | |
| user_id | 整数，非空 | 外键 → users，cascade |
| type | varchar(32)，非空 | 系统通知的类型，或 `message`（管理员写的）、`plugin` |
| params | 长文本，可空 | JSON：系统通知和插件通知的参数 |
| broadcast_id | 整数，可空 | 外键 → notification_broadcasts，cascade。只有 `message` 有 |
| plugin_id | varchar(64)，可空 | 只有 `plugin` 有。不建外键，同 `score_transactions.plugin_id`（ADR-0041） |
| title_key、body_key | varchar(128)，可空 | 插件的文案键。只有 `plugin` 有，`body_key` 可以为空 |
| link | varchar(500)，可空 | 插件给的站内路径 |
| read_at | 时间，可空 | 未读为空 |
| created_at | 时间，非空 | |

索引：`(user_id, read_at)` 数未读，`(user_id, id)` 翻页，`(broadcast_id, user_id)` 唯一，`(plugin_id, id)` 给卸载时的清理用。群发写出的行，`created_at` 记发送的时刻，不记展开到这一行的时刻。

**notification_broadcasts**：管理员的每一次发送。

| 列 | 说明 |
|---|---|
| id | 自增主键 |
| sender_id | 外键 → users，set null |
| audience | varchar(16)：`all`、`users`、`admins`、`specific` |
| title、body | 原文。title varchar(255)，body 长文本 |
| through_uid | 发送那一刻最大的 uid，展开到它为止 |
| cursor_uid | 已经展开到的 uid |
| recipient_count | 已经写进去的行数 |
| status | `sending`、`sent`、`recalled` |
| created_at、finished_at | |

**plugin_notification_keys**：插件通知的幂等键，见"插件"。主键 `(plugin_id, plugin_key)`（`key` 是 MySQL 的保留字，列名同 `score_transactions.plugin_key`）；`user_id`（不建外键）、`fingerprint`（char(64)）、`created_at`。

`docs/schema.md` 的"通知"一节按这里改写，挪进逐表设计。

### 用户侧

- **页头的铃铛**：登录且没有被封禁时显示在用户菜单左边，带未读数（超过 99 写 99+）。点开是新组件 Popover：列最近 5 条未读、"全部标为已读"、"查看全部"。点一条：标为已读；有链接就去链接，没有就去完整页看正文。"全部标为已读"的 `through` 是浮层里最新的那一条，之后才到的不算。没有未读时写"没有新通知"。
- **未读数的刷新**：服务端渲染页头时带上首屏的值；之后铃铛在切换页面、窗口重新获得焦点时请求一次摘要（未读数和最近 5 条）。不做推送。
- **完整页** `/user/notifications`，用户中心导航里排在仪表盘后面：分"全部""未读"两个标签（未读的带数量，同样数到 100），最新的在前，每页 20 条。每条显示标题、时间、正文和"查看"链接，未读的有标记。打开页面不会自动标为已读：点"查看"或"标为已读"才算。能删除一条，只是自己的一条通知，不再确认；"全部标为已读"带上页面打开时看到的最大编号（`through`），之后才到的通知不会被一起标掉，同 ADR-0051。
- 被封禁的用户只看到封禁说明（ADR-0022），没有铃铛。通知照样写进去，解封后能看到。
- 读过的通知留在列表里，直到用户删除或过了保留期。BS 读过就看不到，这一点不照搬。

接口都认会话 Cookie，只能操作自己的通知，别人的返回 404：

| 接口 | 用途 |
|---|---|
| `GET /api/notifications/summary` | 未读数和最近 5 条未读 |
| `GET /api/notifications?filter=all\|unread&page=` | 完整页的列表 |
| `POST /api/notifications/{id}/read` | 标为已读，已经读过的不改 `read_at` |
| `POST /api/notifications/read-all` | `{ through }` |
| `DELETE /api/notifications/{id}` | 删除 |

未读数只数到 100（子查询带 `limit`），用户攒了几十万条也不会每次都整个数一遍。

### 系统通知

| 类型 | 收件人 | 什么时候 | 参数 | 链接 |
|---|---|---|---|---|
| `report.resolved` | 举报人 | 举报被采纳或驳回，包括材质删除时一并结案 | 材质名、结果（采纳、驳回）、退还和奖励的积分 | `/user/reports` |
| `report.pending` | 有 `reports.review` 的人，举报人自己除外 | 有新举报 | 无 | `/admin/reports` |
| `texture.removed` | 上传者 | 管理员下架（改成私有）或删除他的材质，包括采纳举报时删除 | tid、材质名、`unpublished` 或 `deleted` | 下架的链到材质详情页，删除的没有链接 |
| `account.changed` | 账号的主人 | ADR-0036、ADR-0037 发"管理员修改了你的账号"邮件的每一处 | 修改的项目，同邮件的 `AdminAccountChange` | 按项目：账号安全、角色、OAuth 应用 |

- 都和业务写入在同一个事务里写，回滚就不留下。
- 写通知（这几种、指定用户、展开的每一批）都从 `users` 表 `INSERT … SELECT`，收件人同时注销就不写。源查询加上外键检查本来就要加的锁（`packages/db` 的 `lockForReference`）：服务器库是读已提交，不加锁会读到对方删掉、还没提交的用户，等对方提交后报外键错误，这种错误不重试。
- `report.resolved` 写在 `settleReport` 里，覆盖后台处理和材质删除时一并结案的每一条。只写采纳或驳回，不写具体的处理方式："我的举报"页本来也只显示这两种（封禁了上传者不告诉举报人）。
- `report.pending` 不是每条举报一条：管理员还有没读的 `report.pending` 时不再给他写，用一条 `INSERT … SELECT … WHERE NOT EXISTS` 完成。两条举报同时提交，可能多写一条，可以接受。后台概览已经有待处理举报的提示，这条通知是给不常打开后台的管理员的。
- `texture.removed` 只在操作者不是上传者本人时写。删除用户、上传者自己删除不写。改名、改模型、改描述不写，同 ADR-0036 不发邮件。
- `account.changed` 写在 `notifyAccountChanged` 里：配没配邮件都写，邮件照旧只在配置了邮件时发。第三方名称存插件 id 和 Provider id，读的时候翻译，不存翻译好的名称。收回账号照旧只写一条，列出全部项目。

### 管理员发通知

- 新增具名权限 `notifications.send`，管理员和超级管理员都有，同 BS 所有管理员都能发。后台导航加"通知"，页面 `/admin/notifications`：上面是发送表单，下面是发送记录。
- 收件人：
  - 全部用户（`all`，不含被封禁的）；
  - 普通用户（`users`，身份是用户的，对应 BS 的 normal）；
  - 管理员（`admins`，管理员和超级管理员）；
  - 指定用户（`specific`）：一行一个 uid 或邮箱，最多 50 个，不认识的按字段报错，不跳过；被封禁的用户也写，解封后能看到。用户详情页加"发通知"，打开这个页面并填好这个用户（`?to=<uid>`）。
- 标题去掉首尾空白后 1～60 个码位，正文 0～5000 个码位。表单旁边是收件人在完整页上看到的样子（同一个组件），边写边变。
- 群发（前三种）先弹确认框：发出去就到了每个人的列表里，发错了只能撤回。指定用户直接发。
- 不同时发邮件。
- 写审计 `notification.send`，对象是这次发送，details 记收件人类型，指定用户时另记 uid 列表。

**展开**：

- 指定用户在发送的事务里直接写完，状态 `sent`。
- 其余三种在发送的事务里只写 `notification_broadcasts` 一行（记下 `through_uid`）、写审计、入队任务 `core:notification-fanout`。任务按 uid 升序每批 500 人，一批一个事务：先锁住发送那一行，状态不是 `sending` 就停；再 `INSERT … SELECT` 这一批里身份符合的用户，推进 `cursor_uid` 和 `recipient_count`。写入和推进位置在同一个事务里提交，任务中途失败、重跑都不会重复。一次任务跑到预算的时间就停下，在最后一批的事务里续一个任务，不会撞上任务的时限（ADR-0021）。展开到 `through_uid` 时状态改成 `sent`，记 `finished_at`。
- 收件人以发送那一刻为准，之后注册的人收不到，同 BS。身份在展开到他的那一批时判断。

**撤回**：

- 发送记录里每一条都能撤回，有 `notifications.send` 的人都能撤回别人发的。写审计 `notification.recall`。
- 撤回的事务把状态改成 `recalled`（展开中的任务在下一批停下），入队任务分批删除这次发送写出的行。删除跑完之前，列表、摘要和未读数只看没撤回的发送（按 `broadcast_id` 连上发送记录判断），撤回当场就看不到。
- 撤回之后发送记录还留着，显示"已撤回"和撤回前写了多少行。

**发送记录**：最新的在前，每页 50 条：标题、收件人、发送人、已送达的人数和状态、时间、撤回。

### 插件：`notifications.send`

照 ADR-0041 的通用做法：

```ts
// capabilities 新增 'notifications.send'

export interface NotificationsApi {
  send(uid: Uid, notification: PluginNotification, options: { readonly key: string }): Promise<NotificationSendResult>
}

export interface PluginNotification {
  /** 本插件的文案键，任何一种语言里存在即可 */
  readonly title: MessageKey
  readonly body?: MessageKey
  /** 渲染标题和正文用的参数 */
  readonly params?: Readonly<Record<string, string | number>>
  /** 站内路径，以一个 / 开头 */
  readonly link?: string
}

export interface NotificationSendResult {
  /** sent：已写入；duplicate：同一 key 已发过，本次未写；userNotFound：用户不存在。开放联合 */
  readonly status: 'sent' | 'duplicate' | 'userNotFound' | (string & {})
}
```

- 方法挂在 `ctx.notifications` 上，没申请能力就没有这个方法（`Gate`）。事务内的拦截器、迁移、设置校验里不能调用。
- 参数：
  - uid 是正安全整数；
  - 文案键要在本插件任一语言的文案里存在，1～128 个码位，不含 NUL 和不成对的代理项（键原样存进 varchar 列）；
  - `params` 最多 20 项，键 1～64 个码位，字符串值不超过 200 个码位；
  - `link` 以一个 `/` 开头（不能是 `//`），不含反斜杠（浏览器把 `/\example.com` 当成 `//example.com`），不超过 500 个字符，不含控制字符和不成对的代理项。

  不符合就抛错。
- 正文是纯文本，不按 Markdown 渲染；链接只能是站内路径，插件没法在通知里放站外链接。
- 不检查封禁，同 `adjustScore`。不写审计、不发事件，理由同 ADR-0041 的改积分。
- 安装界面按高风险能力展示：能给任何用户发站内通知，内容是插件自己的文案。
- 一次发给一个人。要发给很多人，插件自己分批，例如从自己的表里读收件人。

**幂等键**：规则同改积分（ADR-0041）：本插件内唯一，1～255 个码位，永久保存。同一个 key 再调用一次，uid、文案键、参数、链接都一样就返回 `duplicate`，不一样就拒绝。

ADR-0041 要求幂等键和写入记在同一行，这里改成单独的表 `plugin_notification_keys`。通知会被用户删除，也会过保留期被清理，键要是跟着通知一起删掉，插件重跑就会把通知再发一遍。键和通知在同一个事务里写入；并发的同一个键由主键兜住，撞上了就回滚，再按已有的那一行判断，同改积分。比较参数用 `fingerprint`：uid、文案键、参数（按键排序）、链接组成的 JSON 的 sha256。

**卸载**：卸载插件时，`core:plugin-cleanup` 一并删掉它发的通知；`plugin_notification_keys` 留下，重装同一个 id 的插件，以前发过的不会再发一遍。删除之前，通知显示兜底的"来自插件 {id} 的通知"，没有正文。停用的插件，文案照样认得出来，通知照常显示。

**SDK 和文档**：

- SDK：`capabilities` 加 `notifications.send`；`context` 加 `NotificationsApi`、`PluginNotification`、`NotificationSendResult`；`TransactionalPluginContext` 不变；
- type-tests：没申请能力就没有 `ctx.notifications`；事务内的拦截器里没有；
- api-extractor 报告、作者文档（能力一篇加一节，`migrating-from-bs.md` 的对照表加 `Hook::sendNotification` → `ctx.notifications.send`）；
- plugin-host 的 RPC；
- changeset 覆盖 SDK 和构建命令两个包，次版本，在预发布模式里发下一个候选版。

### 保留期

- 新设置项 `notifications.retentionDays`，分区"高级"，默认 365，0 表示不清理。
- 每天的定时任务 `core:notification-sweep` 按 id 分批删掉早于保留期的通知，已读、未读都删，做法同审计日志的清理（按 id 从小往大扫，遇到没过期的就停）；再删掉早于保留期、已经展开完或者撤回了的发送记录（展开中的不删）。
- 不清理 `plugin_notification_keys`。

### 不导入

从 BS 导入时不导入通知，维持 `docs/schema.md` 的决定：BS 里读过的通知用户本来就看不到，未读的多半已经过时。

## 后果

- BS 的管理员照旧能群发、单发，多了按身份发给管理员、一次指定多个人、发送记录和撤回。
- 举报人、上传者和被管理员改了账号的用户能在站内知道发生了什么；没有配置邮件的站点，后台改账号也能通知到人。
- 群发一次就是收件人数那么多行。几十万用户的站点，一次群发要展开几十秒，表跟着变大，由保留期兜住。
- 群发之后注册的用户收不到这条通知，同 BS。要让新用户看到的长期内容应该写进公告。
- 插件能发通知了，BS 插件里 `Hook::sendNotification` 的用法能迁过来。一次只能发给一个人；要是常见的用法是群发，以后再加批量的方法（次版本）。
- 未读数在切换页面和回到窗口时才刷新，停在一个页面上看不到新通知。
- 用户不能按类型关闭某种通知；通知也不发邮件。

## 考虑过的其他方案

- **群发只存一行，按用户记已读**：列表和未读数要合并两种来源，收件人范围要在读的时候判断，"全部标为已读"要给每条群发补已读记录，删除要留墓碑。每人一行简单得多，空间由保留期兜住。
- **发送时在一个事务里写完所有收件人**：SQLite 的写锁是全局的，群发期间全站的写入排队。
- **发送时按收件人的语言渲染好再存**：ADR-0019 定了读的时候按收件人的语言渲染；用户改了语言，旧通知不跟着变。只有管理员写的通知存原文，因为它本来就只有一种语言（ADR-0019 的后果）。
- **通知同时发邮件**：群发要排几十万封信，容易被服务商当成垃圾邮件限流；要紧的安全提醒已经有邮件。
- **推送（SSE、WebSocket）**：要穿过反向代理、处理多实例，切换页面和回到窗口时刷新已经够用。
- **每条新举报都通知每个管理员**：被人刷举报时会淹没管理员的通知。
- **插件的正文按 Markdown 渲染、链接不限站内**：插件能在通知里放站外的钓鱼链接，用户会以为是站点发的。
- **插件的幂等键记在通知那一行**：通知会被删除和清理，键也就丢了，违背 ADR-0041 的永久保存。
- **卸载插件时保留它的通知、显示兜底文案**：没有正文的通知对用户没有用。积分流水要留着对账，通知不用。
- **铃铛直接链到完整页**：省一个组件，但看一眼有什么新通知也要离开当前页面；BS 的页头也是下拉。
- **导入 BS 的未读通知**：多写一套导入和对账，换来的多半是过时的内容。

## 落地顺序

开分支 `feat/notifications`，走 PR（ADR-0047：加迁移、改 SDK 公开 API）。

1. 迁移和领域层：三张表、用户侧的用例和接口、管理员的发送、展开、撤回、四种系统通知的接入点、设置项和清理任务；`pnpm test:db`。
2. 界面：`packages/ui` 补 Popover（story、截图基线、DESIGN.md 的组件清单），页头的铃铛、`/user/notifications`、`/admin/notifications`、用户详情页的入口。
3. 插件能力：SDK、plugin-host 的 RPC、核心的实现、type-tests、api-extractor 报告、作者文档、changeset；用测试插件覆盖两条加载路径。
