# 能力和上下文

处理函数通过 `ctx` 使用站点服务。需要读用户、角色、材质、改积分、发通知或保存插件数据时，先在 `capabilities` 申请对应能力。

## 九项能力

| 能力 | 提供什么 |
|---|---|
| `users.read` | `ctx.users.get/getMany/searchByNickname`，返回 `PublicUser`：uid、昵称、身份、头像材质编号、注册时间 |
| `users.readPrivate` | 上述方法返回 `PrivateUser`，再加邮箱、邮箱验证状态、积分、语言；增加 `findByEmail`，不必同时申请 `users.read` |
| `users.score` | `ctx.users.adjustScore`，给任何用户加减积分，结果里带余额 |
| `notifications.send` | `ctx.notifications.send`，给任何用户发站内通知，使用插件自己的文案 |
| `players.read` | `ctx.players`，读 Minecraft 角色 |
| `textures.read` | `ctx.textures.get/findByHash`，读材质元数据 |
| `textures.readFile` | `ctx.textures.files.read`，读 PNG 原始字节；不会自动获得元数据方法 |
| `storage.kv` | `ctx.kv`，读写本插件的 KV |
| `storage.tables` | `ctx.db`，查询本插件声明的表，允许声明迁移 |

`users.readPrivate`、`users.score`、`notifications.send` 和 `textures.readFile` 是高风险能力。passwordHasher、login 虽然不是能力名，也因接触密码或第三方身份而按高风险展示。除 `users.score` 和 `notifications.send` 外，其余能力只读核心数据或读写本插件数据；写核心数据的能力一项对应一个领域用例（ADR-0041）。

事件、路由、Provider、任务、UI 本身已经列在 manifest，不需要额外能力。缺失能力时方法在类型上不存在，运行时 RPC 也会被拒绝。

## 每次调用都有的成员

| 成员 | 用法和边界 |
|---|---|
| `plugin` | 只读 `{ id, version }`，版本是插件自己的版本 |
| `site` | 只读 `{ url, name }`；url 来自站点设置，去掉末尾斜杠。管理员没有填站点地址时是空串，路由里可以退回 `new URL(request.url).origin` |
| `settings` | 按本插件 zod schema 解析后的只读设置，含已解密机密项。管理员修改后下一次调用可见；无效时不执行 handler，报设置不完整。见[设置](./settings.md) |
| `t(key, params?, locale?)` | 翻译本插件文案。params 是字符串或数字的记录。请求内默认使用请求语言，其余调用用站点默认语言；显式 locale 可覆盖。找不到或格式化失败时尝试站点默认语言，仍失败就返回键名 |
| `log.debug/info/warn/error(message, fields?)` | 无需 await，日志带插件 id。低于站点日志级别的不记录：默认 `info`，`pnpm dev` 里是 `debug`，站长用 `NEXTSKIN_LOG_LEVEL` 调。message 按 Unicode 码点截到 1000 字符；fields 是 JSON 记录，原样放在日志的 `fields` 字段下，序列化后超过 2000 字符时截断、存成字符串。核心只把 `password`、`token`、`secret` 这类字段名的值换掉，不检查其余内容是否含机密 |
| `signal` | 本次调用的取消信号。停用插件、调用超时时 abort；升级或其他插件启停引起整代换代时，在途调用照常完成。监听它来结束长操作，超时后才返回的结果不再接受 |
| `jobs.enqueue` | 把本插件已声明任务入队，见下文和[任务](./jobs.md) |
| `fetch` | 核心代发 HTTP，见下文 |

`ctx` 只属于这一次调用。所有 RPC 要在 handler 返回前 await；返回后继续用缓存的 ctx 访问核心会被拒绝。不要用模块全局变量保存 ctx，也不要在后台悬挂 Promise。事务内拦截器的成员更少，见[拦截器](./interceptors.md)。

把处理函数里的逻辑拆进辅助函数时，ctx 的类型用 `PluginContext` 拼出来：先把能力、设置和表提成常量，`definePlugin` 和类型共用它们。

```ts
import { definePlugin, table, z, type PluginContext } from '@nextskin/plugin-sdk'

const capabilities = ['storage.tables', 'users.score'] as const
const settings = z.object({ reward: z.number().int().min(0).default(50) })
const tables = { codes: table<{ code: string; uid: number }>() }
type Ctx = PluginContext<typeof capabilities, z.output<typeof settings>, typeof tables>

async function reward(ctx: Ctx, uid: number) {
  await ctx.users.adjustScore(uid, ctx.settings.reward, { reason: 'score.reward', key: `reward:${uid}` })
}

export default definePlugin({ capabilities, settings, tables /* , on, routes … */ })
```

事务内拦截器的 ctx 换成 `TransactionalPluginContext`，三个类型参数相同。

## 读核心数据

所有 uid、pid、tid 必须是正安全整数（1 到 `Number.MAX_SAFE_INTEGER`）。非法参数抛错；合法但不存在的单项返回 `null`，列表返回空数组。

| 方法 | 参数范围和实际行为 |
|---|---|
| `users.get(uid)` | 按 uid 读公开或私有 DTO，由能力决定 |
| `users.getMany(uids)` | 原始数组最多 100 项，之后才去重；按 uid 升序，省略不存在的用户，空数组返回 `[]` |
| `users.searchByNickname(query, { after?, limit? })` | 昵称包含 query 的用户，按 uid 升序。query 是 1–255 个 UTF-16 代码单元，按字面匹配（`%`、`_` 不是通配符），不 trim，含 NUL 时返回 `[]`；ASCII 字母不分大小写，其他字符看数据库（SQLite 只折叠 ASCII）。limit 是 1–100 的整数，默认 100；翻下一页时把 after 设成这一页最后一个 uid，返回不足 limit 个就是最后一页。不返回总数 |
| `users.findByEmail(email)` | 只在 `users.readPrivate` 下存在；原始字符串最多 255 个 UTF-16 代码单元，trim 并转小写后查询 |
| `players.get(pid)` | 按 pid 读 `Player` |
| `players.findByName(name)` | 字符串最多 255 个 UTF-16 代码单元，转小写后按角色名查询，不自动 trim |
| `players.findByUuid(uuid)` | 字符串最多 255 个 UTF-16 代码单元，删除连字符、转小写后必须是 32 位十六进制，否则返回 `null` |
| `players.listByUser(uid)` | 按 pid 升序返回此用户的角色；没有分页参数 |
| `textures.get(tid)` | 按 tid 读 `Texture` |
| `textures.findByHash(hash)` | 字符串最多 64 个 UTF-16 代码单元；同 hash 多个条目时先公开、再 tid 升序取第一条 |
| `textures.files.read(hash)` | 字符串最多 64 个 UTF-16 代码单元；必须匹配 `^[0-9a-f]{64}$`，且文件处于 active 状态，否则 `null`；成功返回 `Uint8Array` |

插件的表只存 uid、后台表格要按昵称搜时，一页一页取出命中的用户，拿 uid 到自己的表里对；总数和排序以自己的表为准：

```ts
const matched: { uid: number; created_at: string }[] = []
let after: number | undefined
for (;;) {
  const users = await ctx.users.searchByNickname(q, { after })
  if (users.length)
    matched.push(...(await ctx.db.selectFrom('records').selectAll().where('uid', 'in', users.map((user) => user.uid)).execute()))
  if (users.length < 100) break
  after = users.at(-1)!.uid
}
```

DTO 字段见类型声明里 `PublicUser`、`PrivateUser`、`Player`、`Texture` 的注释；日期是 ISO 字符串。用户的 `role`、材质的 `type` 是开放字符串联合，要处理未知值，见[版本和兼容](./versioning.md)。

## 改积分

申请 `users.score` 后调用 `ctx.users.adjustScore(uid, delta, { reason, key })`。只申请这一项时，ctx.users 只有 adjustScore；同时申请 users.read 或 users.readPrivate，读写方法合在同一个对象上。

uid 是正安全整数；delta 是非零安全整数，绝对值不超过 2147483647。reason 是本插件任一语言文案中存在的键，按 Unicode 码点计 1–128 字符，不带参数。key 在本插件内唯一，按码点计 1–255 字符，无首尾空白、NUL 和不成对的代理项（写进数据库会变成 U+FFFD，两个不同的键会撞成一个）。键随流水永久保存，停用、卸载、重装同一个插件 id 都不会让已有键失效。

返回 `ScoreAdjustResult`，其中 balance 是调用结束时的余额，用户不存在时为 null：

| status | 含义 |
|---|---|
| applied | 这次记上了 |
| duplicate | 同一 key 已经记过，uid、delta 一样，本次没有修改；reason 不参与去重 |
| insufficient | 扣减会低于 0，什么都没写；原本为负的导入用户扣任何分也返回这个结果 |
| userNotFound | 用户不存在，什么都没写 |

status 是开放字符串联合，还要处理不认识的值。同一个 key 的 uid 或 delta 不同、参数无效、加完超过余额上限、没有能力时抛错；业务结果放在 status 里。失败的 insufficient、userNotFound 不占 key，条件满足后可以重试。RPC 超时或返回失败不表示没有提交，用同一个 key 重试。

核心不检查目标用户是否封禁，也不按路由里的用户判断权限。积分和流水在同一事务里提交，不写审计、不发事件。事务内拦截器、迁移、设置校验不能调用。

例如在 `user.registered` 里给邀请人加分（假设本插件已经核实分享码对应的 uid，文案中有 score.invitation）：

```ts
import { definePlugin } from '@nextskin/plugin-sdk'

export default definePlugin({
  capabilities: ['users.score'],
  on: {
    'user.registered': async ({ ctx, event }) => {
      // 实际插件应按 extra 中的分享码查自己的表；不要直接信任用户提交的 uid。
      const sharerUid = 123
      const result = await ctx.users.adjustScore(sharerUid, 50, {
        reason: 'score.invitation',
        key: `sharer:${event.data.user.uid}`,
      })
      switch (result.status) {
        case 'applied':
        case 'duplicate':
          return
        case 'insufficient':
        case 'userNotFound':
          ctx.log.info('邀请奖励未记入', { status: result.status })
          return
        default:
          throw new Error('无法识别积分结果')
      }
    },
  },
})
```

与插件表配对写入的步骤见[插件表](./tables.md)。

## ctx.notifications

申请 `notifications.send` 后，用 `ctx.notifications.send(uid, notification, { key })` 一次给一个用户发站内通知。内容使用插件自己的文案，读取时按收件人的语言渲染；用户改语言后，旧通知也跟着变。要发给很多人，插件自己分批读取收件人并发送。

```ts
await ctx.notifications.send(uid, {
  title: 'notice.title',
  body: 'notice.body',
  params: { name: 'Alex', count: 1 },
  link: '/user',
}, { key: `welcome:${uid}` })
```

uid 必须是正安全整数。title 必填、body 可选，均为本插件任一语言文案里存在的键，1–128 个码位，不能含 NUL 或不成对的代理项。params 可选，须为最多 20 项的普通对象：键 1–64 个码位，值为不超过 200 个码位的字符串或有限数字；键和字符串值不能含 NUL 或不成对的代理项。正文是纯文本，不渲染 Markdown。

link 可选，只能是站内路径：以一个 `/` 开头，不能以 `//` 开头，不能含反斜杠、U+0000–U+001F、U+007F 或不成对的代理项，最多 500 个 UTF-16 代码单元。

key 在本插件内唯一，1–255 个码位，无首尾空白、NUL 或不成对的代理项，永久保存。同 key 的 uid、title、body、params、link 相同返回 duplicate（params 的键顺序不影响判断），参数不同则抛错；省略的字段按 null 比较。超时不表示没有提交，应用同 key 重试。

返回 `NotificationSendResult`，status 是开放字符串联合，还须处理未知值：

| status | 含义 |
|---|---|
| sent | 通知与永久键已在同一事务里写入 |
| duplicate | 同 key 已发过，本次未写；通知即使已被删除或过期清理也不会再发 |
| userNotFound | 用户不存在，不占用 key，可以重试 |

不检查收件人是否封禁，不写审计、不发事件。事务内的拦截器、迁移、设置校验里不能调用。安装时作为高风险能力展示：能给任何用户发通知。卸载后清理任务会分批删除这个插件发的通知，永久幂等键保留，重装同一个插件 id 仍然有效。

## KV 和入队

`kv.get<T>(key)` 返回 JSON 值或 `null`；泛型 T 不会校验存储内容，读取后需要你自己校验。`kv.set(key, value, { ttlSec }?)` 覆盖值，`kv.delete(key)` 删除，不存在也成功。键按 Unicode 码点计 1–255 字符，不能有首尾空白、NUL 和不成对的代理项；值 JSON 序列化后最多 64 KiB。TTL 是 1–315360000 秒的整数，省略表示不过期；到期读取为 `null`，物理清理由核心异步完成。KV 按插件隔离。

`jobs.enqueue(name, payload, { delaySec?, dedupeKey? }?)` 只能指向自己 `jobs` 里声明的名字；payload 序列化后最多 64 KiB。delaySec 为 0–2592000 的整数，默认 0。dedupeKey 规则同 KV 的键，同名任务在队列中尚未完成时按键去重；方法返回 `void`，不区分新入队还是重复。完成后同键可以再入队。去重不代替 handler 幂等。

`ctx.db` 的参数和结果有独立上限，见[插件表](./tables.md)。

## 出站请求

`network` 写精确的 HTTPS origin，例如 `['https://api.example.com']`。不能带路径、查询、末尾 `/` 或通配符；非默认端口属于 origin 的一部分。省略或空数组表示 `ctx.fetch` 不能访问任何地址。

```ts
import { definePlugin } from '@nextskin/plugin-sdk'

export default definePlugin({
  capabilities: [],
  network: ['https://api.example.com'],
  jobs: {
    ping: {
      async handler({ ctx }) {
        const response = await ctx.fetch('https://api.example.com/health', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        })
        if (!response.ok) throw new Error('health request failed')
      },
    },
  },
})
```

签名是 `fetch(url: string | URL, init?: { method?, headers?, body? })`。method 支持 GET、HEAD、POST、PUT、PATCH、DELETE、OPTIONS，默认 GET。只转发这三项，不接收 Request 对象；没有可单独设置的 `signal`、`redirect` 等选项，本次调用期限统一控制请求。host、connection、content-length、transfer-encoding、keep-alive、upgrade 请求头丢弃。

请求体和响应体各完整缓冲，分别最多 10 MiB，不支持流式处理。自动跟随最多 5 次重定向，每一跳都检查 HTTPS、无 URL 用户名密码、origin 在白名单。303 以及 POST 的 301/302 改成无请求体 GET，并移除 content-type；其他重定向保留方法。重定向沿用原请求头（除上述移除 content-type 的情况），包括跨越两个已声明 origin 时的 Authorization；不要让不应共享凭据的地址接收重定向。白名单不符、超限、网络失败均抛错。HTTP 4xx/5xx 本身仍返回 Response，需要你检查 `ok`。

返回的 Response 经过跨进程序列化，`url` 为空串，`redirected` 为 false。`ctx.signal` 中止时出站请求也中止。Node 24 上的白名单只约束 `ctx.fetch`，详见[安全须知](./security.md)。

## RequestScope

路由和拦截器额外收到 `scope: RequestScope`：`requestId`、`actor`、`locale`、`ip`。身份看 `actor`，不解析 Cookie 或 Authorization。`actor` 是用户（uid、role）、system，或预留的 plugin 分支；第一版核心不产生 plugin 操作者。public 路由即使请求带会话也一律是 system。`ip` 由核心的可信代理规则解析，`locale` 是本次请求语言。
