# @nextskin/plugin-sdk

## 1.0.0-rc.4

### Minor Changes

- b31b57e: 新增能力 `notifications.send`：`ctx.notifications.send(uid, notification, { key })` 用插件自己的文案给一个用户发站内通知，按收件人的语言渲染，正文是纯文本、链接只能是站内路径，key 永久幂等（同 key 同参数返回 `duplicate`，参数不同拒绝）；安装时按高风险展示，卸载时删掉插件发的通知。新类型 `NotificationsApi`、`PluginNotification`、`NotificationSendResult`（ADR-0052）。

## 1.0.0-rc.3

### Minor Changes

- fa4af7c: `users.read`、`users.readPrivate` 新增 `ctx.users.searchByNickname(query, { after?, limit? })`：昵称包含 query 的用户，ASCII 字母不分大小写，按 uid 升序往后翻页，每次最多 100 个；新类型 `UserSearchOptions`（ADR-0050）。

## 1.0.0-rc.2

### Minor Changes

- e24ed56: 新增事务外、失败时拒绝的拦截点 `user.action`，供插件限制用户本人管理角色、材质、OAuth 应用和举报（ADR-0046）。
- 2652da7: 新增事务外、失败时拒绝的拦截点 `yggdrasil.issueToken`，覆盖启动器登录、刷新和 Connect 带 Join 的令牌签发（ADR-0045）。

## 1.0.0-rc.1

### Minor Changes

- 7cc757f: 新增事件 `player.transferred`（ADR-0036）：管理员在后台把角色转让给另一个用户后发出，带转让之后的 `player: Player`（`uid` 是新主人，pid、UUID、名字不变）和原主人的 `previousUid: Uid`；清掉新主人看不到的材质时先发 `player.texturesChanged`。`player.texturesChanged` 的说明补上转让和下架引起的清空；文档里 `user.roleChanged` 的“角色”改称“身份”，并说明 actor 是发起操作的人，后台操作和连带效果中 `data` 里的用户可能不是 actor，也可能波及管理员自己，只看信封分不出后台操作和连带效果。
- d7ed769: 新增能力 `users.score` 和 `ctx.users.adjustScore`（ADR-0041）：插件以永久幂等键给任何用户加减积分，`ScoreAdjustResult` 返回业务状态和余额。注册表单字段新增 `fromQuery`，允许 text、textarea、number、select 从带插件 id 的查询参数预填。

### Patch Changes

- bcd7cd0: 更新 BS 插件迁移指南：验证码已由核心内置，在后台设置的验证码分区启用（ADR-0038）。
- c22e0ba: KV 的键和任务的 `dedupeKey` 不再接受 NUL 和不成对的代理项，规则同 `adjustScore` 的 key：PostgreSQL 存不了 NUL；不成对的代理项写进数据库会变成 U+FFFD，两个不同的键会撞成一个。

## 1.0.0-rc.0

### Major Changes

- bbb2787: 第一个正式版本（ADR-0033、ADR-0035）。
  
  - `@nextskin/plugin-sdk`：用 `definePlugin` 声明插件会做的全部事情。16 个事件、1 个拦截点（`user.register`）、2 类 Provider（`passwordHasher`、`login`）、7 项只读核心数据或读写插件自己数据的能力；插件自有表、KV、任务和定时任务、挂在 `/plugins/{id}/` 下的路由；声明式的导航、页面（表格、表单、统计、Markdown）和注册表单字段；设置页由 zod schema 生成。
  - `@nextskin/plugin-cli`：`nextskin-plugin build` 把插件打成插件包，在站点后台上传安装。
  
  两个包要装同一个版本。文档在 SDK 包的 `docs/` 目录里，从 README 看起。
