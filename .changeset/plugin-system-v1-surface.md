---
'@nextskin/plugin-sdk': major
---

按 ADR-0033 收窄到第一版的公开面：SDK 1.0 只包含核心已经实现的东西，推迟的部分从类型里删掉。

- 能力：删除 `users.score`、`notifications.send`、`ui.script`；上下文删除 `notifications`、`users.adjustScore`。
- `ctx.db`（`PluginDb`）去掉开事务、独占连接、DDL 等方法：插件不能自己开事务，每条语句单独提交；DDL 只在迁移里有。迁移改用 `PluginMigration`，只有 `up`。
- 事务内的拦截器拿到收窄后的上下文 `TransactionalPluginContext`：只有 `db` 和插件信息、设置、翻译、日志、取消信号，没有 `fetch`、`kv`、`jobs`，也不能读核心数据。
- 事件：删除 `user.loggedIn`。
- 拦截点只留 `user.register`，不能改字段，预算 300 ms；删除 `patch()`、`Patch` 和 `failClosed`，`InterceptResult` 不再带类型参数。
- Provider 只留 `passwordHasher` 和 `login`；删除 `captcha`、`mail` 及相关类型。
- UI：删除 `component` 视图、`widgets`、`SlotName`、`ClientModuleRef`；`FormName` 只留 `auth.register`。
- `definePlugin` 删除逃生舱 `setup`。
- manifest：Provider 只留两类并带上核心在本进程内要用的字段（`detect`、`label`、`icon`）；路由带上 `maxBodyBytes` 和 `rateLimit`，任务带上 `maxAttempts` 和 `timeoutMs`，定时任务带上 `payload`；删除 `entry.client`、拦截器的 `failClosed`。
- `secret()` 在 JSON Schema 里标 `writeOnly`（同 ADR-0028）；设置项文案键补上 `fields`、`options` 两种嵌套。
