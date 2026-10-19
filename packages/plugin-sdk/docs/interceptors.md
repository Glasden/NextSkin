# 拦截器

第一版只有 `user.register`，用于拒绝不符合插件规则的注册。操作已经完成后的工作放在[事件](./events.md)中。

## 时机和返回值

普通注册表单和第三方登录的首次“完成注册”都在新建用户前、注册事务内调用它。安装向导创建第一个超级管理员、BS 导入不经过它。

input 有 `email`、`nickname`、`playerName`（不顺带创建角色时为 null）、`ip`、`extra`。extra 只包含本插件贡献的注册字段，值是字符串，规则见[界面](./ui.md)。另有 `scope: RequestScope`。

```ts
import { definePlugin, deny, z } from '@nextskin/plugin-sdk'

export default definePlugin({
  capabilities: [],
  settings: z.object({ enabled: z.boolean().default(true) }),
  intercept: {
    'user.register': {
      priority: 100,
      async handler({ ctx }) {
        if (!ctx.settings.enabled) return deny('registration_paused', ctx.t('error.paused'))
      },
    },
  },
})
```

`error.paused` 需写进本插件的 locales。返回 `deny(code, message)` 拒绝；不返回值放行。不能返回 patch、true、修改后的 input 或其他结构，非法返回值按失败处理。代码不能改注册数据；`patch` 类型是 never，因为昵称已经在事务前校验，注册还可能同时建同名角色。

code 是机器可读原因，按 Unicode 码点截到 64 字符；message 是已本地化用户文案，截到 200 字符。拒绝的 API 错误是 `registration_denied`，带插件 id、reason 和 message。

## 策略、事务和失败

公开常量 `interceptorPolicies['user.register']` 为：

```ts
{ onFailure: 'closed', timeoutMs: 300, transactional: true }
```

四种数据库预算都是 300 毫秒，包含读取设置等准备工作。多个插件按 priority 从小到大、再按插件 id 排序执行；priority 默认 100，必须是安全整数。任一个 deny 立即短路。

抛错、超时、host 不可用、非法返回值都拒绝注册，返回 `plugin_unavailable`。同一插件的此拦截点连续失败 3 次后熔断 30 秒，期间直接拒绝；正常放行和合法 deny 会清除失败计数。不能自行改失败策略或延长期限。

上下文只有 `plugin`、`site`、`settings`、`t`、`log`、`signal`，以及申请了 `storage.tables` 时的 `db`。**没有 fetch、kv、jobs，也没有 users、players、textures**；运行时同样拒绝这些 RPC。

这里的 db 语句加入核心事务，随注册一起提交或回滚。注册事务可能整体重跑，所以 handler 可能被调用多次；本插件表的写入会一起回滚，日志则可能重复。SQLite 写锁是全局的，网络、KV、任务入队既会延长持锁时间，又无法随事务回滚，因此不提供。

邀请码应使用一条带条件的 UPDATE 消费名额，并检查影响行数，不能先读剩余次数再写回。完整实现见 [invitation-codes](https://github.com/Glasden/NextSkin/tree/main/plugins/invitation-codes)。需要外部查询才能决定是否注册的插件，第一版没有对应的事务外拦截点。
