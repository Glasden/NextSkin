# 能力和上下文

处理函数通过 `ctx` 使用站点服务。需要读用户、角色、材质，或保存插件数据时，先在 `capabilities` 申请对应能力。

## 七项能力

| 能力 | 提供什么 |
|---|---|
| `users.read` | `ctx.users.get/getMany`，返回 `PublicUser`：uid、昵称、用户角色、头像材质编号、注册时间 |
| `users.readPrivate` | 上述方法返回 `PrivateUser`，再加邮箱、邮箱验证状态、积分、语言；增加 `findByEmail`，不必同时申请 `users.read` |
| `players.read` | `ctx.players`，读 Minecraft 角色 |
| `textures.read` | `ctx.textures.get/findByHash`，读材质元数据 |
| `textures.readFile` | `ctx.textures.files.read`，读 PNG 原始字节；不会自动获得元数据方法 |
| `storage.kv` | `ctx.kv`，读写本插件的 KV |
| `storage.tables` | `ctx.db`，查询本插件声明的表，允许声明迁移 |

`users.readPrivate` 和 `textures.readFile` 是高风险能力。passwordHasher、login 虽然不是能力名，也因接触密码或第三方身份而按高风险展示。七项能力都不能写核心数据。

事件、路由、Provider、任务、UI 本身已经列在 manifest，不需要额外能力。缺失能力时方法在类型上不存在，运行时 RPC 也会被拒绝。

## 每次调用都有的成员

| 成员 | 用法和边界 |
|---|---|
| `plugin` | 只读 `{ id, version }`，版本是插件自己的版本 |
| `site` | 只读 `{ url, name }`；url 来自站点设置，去掉末尾斜杠 |
| `settings` | 按本插件 zod schema 解析后的只读设置，含已解密机密项。管理员修改后下一次调用可见；无效时不执行 handler，报设置不完整。见[设置](./settings.md) |
| `t(key, params?, locale?)` | 翻译本插件文案。params 是字符串或数字的记录。请求内默认使用请求语言，其余调用用站点默认语言；显式 locale 可覆盖。找不到或格式化失败时尝试站点默认语言，仍失败就返回键名 |
| `log.debug/info/warn/error(message, fields?)` | 无需 await，日志带插件 id。message 按 Unicode 码点截到 1000 字符；fields 是 JSON 记录，序列化后截到 2000 字符，截断后不保证仍是合法 JSON。核心不检查是否含机密 |
| `signal` | 本次调用的取消信号。停用插件、调用超时时 abort；升级或其他插件启停引起整代换代时，在途调用照常完成。监听它来结束长操作，超时后才返回的结果不再接受 |
| `jobs.enqueue` | 把本插件已声明任务入队，见下文和[任务](./jobs.md) |
| `fetch` | 核心代发 HTTP，见下文 |

`ctx` 只属于这一次调用。所有 RPC 要在 handler 返回前 await；返回后继续用缓存的 ctx 访问核心会被拒绝。不要用模块全局变量保存 ctx，也不要在后台悬挂 Promise。事务内拦截器的成员更少，见[拦截器](./interceptors.md)。

## 读核心数据

所有 uid、pid、tid 必须是正安全整数（1 到 `Number.MAX_SAFE_INTEGER`）。非法参数抛错；合法但不存在的单项返回 `null`，列表返回空数组。

| 方法 | 参数范围和实际行为 |
|---|---|
| `users.get(uid)` | 按 uid 读公开或私有 DTO，由能力决定 |
| `users.getMany(uids)` | 原始数组最多 100 项，之后才去重；按 uid 升序，省略不存在的用户，空数组返回 `[]` |
| `users.findByEmail(email)` | 只在 `users.readPrivate` 下存在；原始字符串最多 255 个 UTF-16 代码单元，trim 并转小写后查询 |
| `players.get(pid)` | 按 pid 读 `Player` |
| `players.findByName(name)` | 字符串最多 255 个 UTF-16 代码单元，转小写后按角色名查询，不自动 trim |
| `players.findByUuid(uuid)` | 字符串最多 255 个 UTF-16 代码单元，删除连字符、转小写后必须是 32 位十六进制，否则返回 `null` |
| `players.listByUser(uid)` | 按 pid 升序返回此用户的角色；没有分页参数 |
| `textures.get(tid)` | 按 tid 读 `Texture` |
| `textures.findByHash(hash)` | 字符串最多 64 个 UTF-16 代码单元；同 hash 多个条目时先公开、再 tid 升序取第一条 |
| `textures.files.read(hash)` | 字符串最多 64 个 UTF-16 代码单元；必须匹配 `^[0-9a-f]{64}$`，且文件处于 active 状态，否则 `null`；成功返回 `Uint8Array` |

DTO 字段见类型声明里 `PublicUser`、`PrivateUser`、`Player`、`Texture` 的注释；日期是 ISO 字符串。用户的 `role`、材质的 `type` 是开放字符串联合，要处理未知值，见[版本和兼容](./versioning.md)。

## KV 和入队

`kv.get<T>(key)` 返回 JSON 值或 `null`；泛型 T 不会校验存储内容，读取后需要你自己校验。`kv.set(key, value, { ttlSec }?)` 覆盖值，`kv.delete(key)` 删除，不存在也成功。键按 Unicode 码点计 1–255 字符，不能有首尾空白；值 JSON 序列化后最多 64 KiB。TTL 是 1–315360000 秒的整数，省略表示不过期；到期读取为 `null`，物理清理由核心异步完成。KV 按插件隔离。

`jobs.enqueue(name, payload, { delaySec?, dedupeKey? }?)` 只能指向自己 `jobs` 里声明的名字；payload 序列化后最多 64 KiB。delaySec 为 0–2592000 的整数，默认 0。dedupeKey 按 Unicode 码点计 1–255 字符且无首尾空白，同名任务在队列中尚未完成时按键去重；方法返回 `void`，不区分新入队还是重复。完成后同键可以再入队。去重不代替 handler 幂等。

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
