# 拦截器

`user.register` 用于拒绝注册，`yggdrasil.issueToken` 用于拒绝能进服的令牌签发。操作已经完成后的工作放在[事件](./events.md)中。

## user.register：时机和返回值

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

### 策略、事务和失败

公开常量 `interceptorPolicies['user.register']` 为：

```ts
{ onFailure: 'closed', timeoutMs: 300, transactional: true }
```

四种数据库预算都是 300 毫秒，包含读取设置等准备工作。多个插件按 priority 从小到大、再按插件 id 排序执行；priority 默认 100，必须是安全整数。任一个 deny 立即短路。

抛错、超时、host 不可用、非法返回值都拒绝注册，返回 `plugin_unavailable`。同一插件的此拦截点连续失败 3 次后熔断 30 秒，期间直接拒绝；正常放行和合法 deny 会清除失败计数。不能自行改失败策略或延长期限。

上下文只有 `plugin`、`site`、`settings`、`t`、`log`、`signal`，以及申请了 `storage.tables` 时的 `db`。**没有 fetch、kv、jobs，也没有 users、players、textures**；运行时同样拒绝这些 RPC。

这里的 db 语句加入核心事务，随注册一起提交或回滚。注册事务可能整体重跑，所以 handler 可能被调用多次；本插件表的写入会一起回滚，日志则可能重复。SQLite 写锁是全局的，网络、KV、任务入队既会延长持锁时间，又无法随事务回滚，因此不提供。

邀请码应使用一条带条件的 UPDATE 消费名额，并检查影响行数，不能先读剩余次数再写回。完整实现见 [invitation-codes](https://github.com/Glasden/NextSkin/tree/main/plugins/invitation-codes)。需要外部查询才能决定是否注册的插件，第一版没有对应的事务外拦截点。

## yggdrasil.issueToken

在签发能进服的令牌之前、事务外调用，input 是 `{ uid, via }`，不含邮箱和角色；需要时按能力读核心数据。

- `via: 'authenticate'`：启动器密码登录，密码、封禁、邮箱验证和 clientToken 检查通过之后，签发事务之前。拒绝不计入登录失败限流。
- `via: 'refresh'`：启动器刷新，令牌、clientToken、封禁和角色归属（包括新选角色）检查之后，签发事务之前。拒绝保留旧令牌。
- `via: 'oauth'`：Connect `/oauth2/token` 签发之后、核对事务之前。覆盖授权码、设备码、刷新令牌三种 grant；只有 scopes 包含 `Yggdrasil.Server.Join` 才调用。拒绝时删除刚签发的访问令牌和刷新令牌。

不调用的地方：validate、join、hasJoined、invalidate、signout，以及网页登录、第三方登录和通行密钥。via 是开放字符串联合，次版本可能增加成员。

`scope.actor` 是这个用户（uid 和身份），locale 是用户语言，为 null 时用站点默认语言；ip 是核心按可信代理规则解析的客户端 IP，未知时为空串。

策略是 `{ onFailure: 'closed', timeoutMs: 2000, transactional: false }`。上下文是完整 ctx：fetch、jobs，以及按能力提供的 kv、db、users、players、textures；可以在这里请求外部服务，不会占用签发事务的写锁。排序、短路、返回值限制和码点截断与 user.register 相同。抛错、超时、host 不可用、非法返回值、熔断都拒绝签发；连续失败 3 次熔断 30 秒。启用着却取不到包时，所有失败时拒绝的点都按不可用处理；有 manifest 时只影响它声明的点。

启动器收到 403 ForbiddenOperationException，显示 deny 的 message；不可用时显示核心的“外置登录暂时不可用，请稍后再试。”。Connect 返回 invalid_grant，error_description 是 message，不可用时为 `Token issuance is temporarily unavailable`。刷新令牌已被 Better Auth 轮换，被拒绝后需要重新授权。

例如从本插件的表检查绑定状态（bindings 表需由插件迁移创建，error.bindRequired 写进插件 locales）：

```ts
import { definePlugin, deny, table } from '@nextskin/plugin-sdk'

export default definePlugin({
  capabilities: ['storage.tables'],
  tables: { bindings: table<{ uid: number }>() },
  intercept: {
    'yggdrasil.issueToken': async ({ input, ctx }) => {
      const binding = await ctx.db.selectFrom('bindings').select('uid').where('uid', '=', input.uid).executeTakeFirst()
      if (!binding) return deny('binding_required', ctx.t('error.bindRequired'))
    },
  },
})
```

解绑后已签发的令牌在有效期内仍可进服，默认最长 3 天（yggdrasil.tokenValidSeconds）；之后刷新被拒绝。需要立即失效时，管理员对该用户执行“退出全部登录”。
