# ADR-0050 插件按昵称搜索用户：`ctx.users.searchByNickname`，包含、不分大小写，按 uid 往后翻页，每次最多 100 个

- 状态：已采纳
- 日期：2026-10-21
- 补充 ADR-0033："能力"一节里 `users.read`、`users.readPrivate` 多一个方法

## 背景

ADR-0033 给插件的核心数据都按 id 读：`users.get`、`getMany`，`users.readPrivate` 另有 `findByEmail`。插件自己的表通常只存 uid，后台的表格（`kind: 'table'`、`searchable`）要按用户的昵称搜，就只能读出自己的全部记录、每 100 个一批调 `getMany` 取昵称，再在插件里筛。每次搜索的调用次数跟着插件的记录数涨：一千条要十来次，一万条要一百次，搜的词再具体也一样。

插件表的网关只认插件自己声明的表（ADR-0033、S5），插件没法把"昵称包含"写进同一条 SQL。

## 决定

```ts
interface UsersPublicApi {
  searchByNickname(query: string, options?: UserSearchOptions): Promise<PublicUser[]>
}
interface UsersPrivateApi {
  searchByNickname(query: string, options?: UserSearchOptions): Promise<PrivateUser[]>
}
interface UserSearchOptions {
  readonly after?: Uid
  readonly limit?: number
}
```

- `users.read` 和 `users.readPrivate` 都有，返回的 DTO 和 `get` 一样由能力决定。昵称本来就是公开资料，不另加能力。
- 昵称包含 `query` 就命中，按字面匹配（`%`、`_` 不是通配符），用 `packages/db` 的 `containsInsensitive`，和后台的用户搜索相同。ASCII 字母保证不分大小写，其他字符看数据库：SQLite 的 `lower()` 只折叠 ASCII。
- `query` 是 1 到 255 个 UTF-16 代码单元，不 trim，搜索框里的词由插件自己处理。含 NUL 的返回空数组：昵称不可能含 NUL（`users/validation.ts`），PostgreSQL 收到 NUL 还会报错。
- 按 uid 升序。`after` 是上一页最后一个 uid（正安全整数），只返回比它大的；`limit` 是 1 到 100 的整数，默认 100。返回不足 `limit` 个就是最后一页。不返回总数。
- 和其他读核心数据的方法一样，事务内的拦截器、迁移、设置校验里不能调用。

### 按 uid 往后翻，不用页码

- 插件拿到一批 uid，还要到自己的表里对一遍，总数和排序都以插件的表为准。核心算的总数用不上，`count` 白扫一遍用户表。
- 用页码时，两次调用之间有人注册、改昵称，结果会跳过或重复；按 uid 往后翻不会重复。
- 和 `getMany` 一样一批 100 个，插件拿一页 uid 正好到自己的表里 `where uid in (…)`（网关的列表最多 1000 项）。

### SDK 和文档的改动

- `context.ts`：两个接口加方法，新类型 `UserSearchOptions`；type-tests：只有 `users.score` 时没有这个方法，`users.read` 下搜到的没有邮箱，`users.readPrivate` 下有；
- 作者文档 `context.md` 的能力表和"读核心数据"表；
- changeset：两个包都是次版本。

### 测试

- 四种数据库：包含、ASCII 大小写、`%` `_` 按字面、不 trim、翻页、`limit` 的默认值和上下限、NUL 返回空数组；空串、超长、`after` 和 `limit` 不对时拒绝；
- RPC：`users.read` 返回公开 DTO，`users.readPrivate` 返回私有 DTO，只有 `users.score` 时拒绝；host 不转发省略的选项。

## 后果

- 插件按昵称搜索的成本跟着命中的用户数涨，不再跟着插件自己的记录数涨。搜得很宽（一两个字母）时，插件仍要翻很多页。
- 公开面多一个方法，1.0.0 之后冻住。

## 考虑过的其他方案

- **插件表的查询可以 join 核心的 `users` 表**：网关要开放核心表和列的白名单，插件就能绕过 DTO 读表里的列，违背"只暴露 DTO，不暴露表结构"（`packages/plugin-sdk/AGENTS.md`）。
- **页码加总数**：见上文。
- **只返回 uid**：插件多半要显示昵称，还得再调一次 `getMany`。
- **按前缀搜索**：前缀能用索引，但后台搜索框的习惯是包含；用户表在这个量级全表扫描可以接受，后台的用户搜索也是这样。
