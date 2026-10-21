import type { Kysely } from 'kysely'
import type { Capability, Gate, Has, Or } from './capabilities.ts'
import type { Json, Pid, Player, PrivateUser, PublicUser, Texture, Tid, Uid } from './dto.ts'
import type { MessageKey } from './ui.ts'

/**
 * 不用等核心回应的那部分上下文：插件信息、设置、翻译、日志、取消信号。
 * 事务内的拦截器只拿得到这些，再加上 `db`（见 `TransactionalPluginContext`）。
 */
export interface PluginContextLocal<S> {
  readonly plugin: { readonly id: string; readonly version: string }
  /** url 去掉了末尾斜杠；管理员没有填站点地址时是空串。 */
  readonly site: { readonly url: string; readonly name: string }
  /** 当前设置；管理员修改后，下一次调用就能看到新值。 */
  readonly settings: Readonly<S>
  /** 取本插件的翻译。在请求内调用时默认使用请求的语言。 */
  t(key: MessageKey, params?: Readonly<Record<string, string | number>>, locale?: string): string
  /** 日志带插件 id，核心不检查内容：不要写密码、令牌、密钥这类机密。 */
  readonly log: Logger
  /** 插件停用或这次调用超时时 abort；换代时在途调用照常做完。长时间运行的操作应该监听它。 */
  readonly signal: AbortSignal
}

/**
 * 插件上下文：插件接触核心的唯一途径。
 *
 * 在插件 host 进程里，这里的每个方法都是一次到核心的 RPC；
 * 对官方插件（在核心进程内运行）则是直接调用，参数和返回值同样序列化一次。插件代码不需要知道区别。调用结束后继续使用 ctx 的 RPC 会被拒绝。
 */
export interface PluginContextBase<S> extends PluginContextLocal<S> {
  readonly jobs: {
    /** name 必须是本插件 `jobs` 中声明的键；载荷序列化后不超过 64 KiB。
     * delaySec 是 0–2592000 的整数，默认 0；dedupeKey 是 1–255 字符，无首尾空白、NUL 和不成对的代理项。
     * 同名任务的同一键在未完成期间去重；返回值不区分是否新入队。 */
    enqueue(name: string, payload: Json, options?: { delaySec?: number; dedupeKey?: string }): Promise<void>
  }
  /**
   * 出站 HTTP。自动跟随重定向最多 5 跳，每一跳都按 `network` 检查。
   * 请求体和响应体完整缓冲，各不超过 10 MiB；`ctx.signal` 到期时请求中止。
   * 返回的 Response 的 `url` 是空串，`redirected` 是 false。
   */
  fetch(url: string | URL, init?: PluginFetchInit): Promise<Response>
}

/** 出站请求只转发这三项。以后支持别的选项时加可选的属性，是次版本（ADR-0035） */
export interface PluginFetchInit {
  readonly method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS'
  readonly headers?: RequestInit['headers']
  readonly body?: RequestInit['body']
}

/** message 截到 1000 字符，fields 序列化后截到 2000 字符。 */
export interface Logger {
  debug(message: string, fields?: Readonly<Record<string, Json>>): void
  info(message: string, fields?: Readonly<Record<string, Json>>): void
  warn(message: string, fields?: Readonly<Record<string, Json>>): void
  error(message: string, fields?: Readonly<Record<string, Json>>): void
}

/** 所有 id 都须为正安全整数；查询字符串最多 255 字符。 */
export interface UsersPublicApi {
  get(uid: Uid): Promise<PublicUser | null>
  /** 最多 100 项；按 id 排序、去重，省略不存在的用户。 */
  getMany(uids: readonly Uid[]): Promise<PublicUser[]>
}

/** id 须为正安全整数，邮箱最多 255 字符。 */
export interface UsersPrivateApi {
  get(uid: Uid): Promise<PrivateUser | null>
  /** 最多 100 项；按 id 排序、去重，省略不存在的用户。 */
  getMany(uids: readonly Uid[]): Promise<PrivateUser[]>
  findByEmail(email: string): Promise<PrivateUser | null>
}

/** `users.score`：以插件的身份改积分（ADR-0041）。 */
export interface UsersScoreApi {
  /**
   * 给任何用户加减积分，不检查封禁。uid 须为正安全整数；delta 是非零安全整数，绝对值不超过 2147483647。
   * reason 必须是本插件任一语言的文案里存在的键（1–128 个码位），不带参数。
   * key 在本插件内唯一，1–255 个码位，无首尾空白、NUL 和不成对的代理项；随流水永久保存，卸载重装后仍有效。
   * 同一 key 的 uid、delta 相同返回 duplicate，不同则拒绝；reason 不参与去重。
   * 业务结果在 status 里，参数不对、超过余额上限或没有能力才抛错。
   * 返回值包含调用结束时的余额。事务内的拦截器、迁移和设置校验里不能调用。
   */
  adjustScore(uid: Uid, delta: number, options: ScoreAdjustOptions): Promise<ScoreAdjustResult>
}

/** 积分变动的原因和永久幂等键。 */
export interface ScoreAdjustOptions {
  /** 本插件的文案键，任何一种语言里存在即可。 */
  readonly reason: MessageKey
  /** 本插件内永久的幂等键。 */
  readonly key: string
}

/** 改积分的业务结果；参数错误仍抛错。 */
export interface ScoreAdjustResult {
  /**
   * applied：这次已记账；duplicate：同一 key 已记过，本次未改。
   * insufficient：扣减会低于 0（包括原本为负的余额），什么都没写；userNotFound：用户不存在。
   * 开放联合：调用方还须处理不认识的 status。
   */
  readonly status: 'applied' | 'duplicate' | 'insufficient' | 'userNotFound' | (string & {})
  /** 调用结束时的余额；用户不存在时为 null */
  readonly balance: number | null
}

/** id 须为正安全整数，查询字符串最多 255 字符。 */
export interface PlayersApi {
  get(pid: Pid): Promise<Player | null>
  findByName(name: string): Promise<Player | null>
  findByUuid(uuid: string): Promise<Player | null>
  listByUser(uid: Uid): Promise<Player[]>
}

/** tid 须为正安全整数，hash 最多 64 字符。 */
export interface TexturesApi {
  get(tid: Tid): Promise<Texture | null>
  /** 同一 hash 可有多个条目，优先返回公开的，其次取 tid 最小的。 */
  findByHash(hash: string): Promise<Texture | null>
}

/** hash 最多 64 字符；不是 64 位小写十六进制或文件不可用时返回 null。 */
export interface TextureFilesApi {
  read(hash: string): Promise<Uint8Array | null>
}

/** 键为 1–255 字符，不允许首尾空白、NUL 和不成对的代理项。 */
export interface KvApi {
  get<T extends Json>(key: string): Promise<T | null>
  /** 值序列化后不超过 64 KiB。ttlSec 为 1–315360000 的整数；省略时不过期，到期后读到 null。 */
  set(key: string, value: Json, options?: { ttlSec?: number }): Promise<void>
  delete(key: string): Promise<void>
}

/** 插件表的类型声明：`tables: { codes: table<CodeRow>() }`。 */
declare const rowType: unique symbol
export interface TableDef<Row> {
  readonly kind: 'table'
  readonly [rowType]?: Row
}
export type TableMap = Readonly<Record<string, TableDef<object>>>
export type RowsOf<T extends TableMap> = { [K in keyof T]: T[K] extends TableDef<infer R> ? R : never }

/**
 * 插件拿不到的 Kysely 方法：开事务、独占连接、DDL、换插件或 schema、内省、销毁。
 * 插件不能自己开事务（每条语句单独提交，需要原子性就写一条带条件的语句）；DDL 只在迁移里有。
 */
type DbOmitted =
  | 'transaction'
  | 'startTransaction'
  | 'connection'
  | 'schema'
  | 'withPlugin'
  | 'withoutPlugins'
  | 'withSchema'
  | 'withTables'
  | 'introspection'
  | 'destroy'
  | 'with'
  | 'withRecursive'
  | 'mergeInto'
  | 'replaceInto'

/**
 * 插件自己的数据库。
 *
 * - 表名写逻辑名（`codes`），核心自动映射到 `p_<插件 id>__codes`。表名、索引名、约束名为 `[a-z][a-z0-9]*(?:_[a-z0-9]+)*`，物理名不超过 63 字符。
 * - 只能访问 `tables` 里声明过的表；不支持原始 SQL（`sql` 模板），核心会拒绝。
 * - 只支持一个 FROM 项加最多 4 个 inner/left JOIN；不支持 RIGHT JOIN、FOR UPDATE、流式读取；不支持 INSERT…SELECT、CTE；RETURNING 只能用在 INSERT 上；日期参数用 ISO 字符串。
 * - 每条语句单独提交。只有事务内的拦截器例外：那里的语句加入核心事务，随它一起提交或回滚。
 * - 查询在核心进程里重新编译后执行，插件永远拿不到数据库凭据。
 * 查询构建器和 schema 沿用 Kysely 类型，超出网关白名单的写法会在运行时拒绝并说明原因。
 * 完整规则见插件作者文档的插件表一篇。
 */
export type PluginDb<T extends TableMap> = Omit<Kysely<RowsOf<T>>, DbOmitted>

/** 迁移里的数据库：多了建表、加列、建索引的 `schema`，同样不能开事务。表名写逻辑名。 */
// 同 Kysely 自己的 Migration：迁移执行时的表结构不一定是现在 `tables` 里声明的样子
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PluginMigrationDb = Omit<Kysely<any>, Exclude<DbOmitted, 'schema'>>

/** 插件表的迁移。只往前走：核心不执行 down，插件也不支持降级。每次 up 限 60 秒。 */
export interface PluginMigration {
  up(db: PluginMigrationDb): Promise<void>
}

type UsersApiFor<C extends readonly Capability[]> =
  Has<C, 'users.readPrivate'> extends true ? UsersPrivateApi : UsersPublicApi

type TexturesApiFor<C extends readonly Capability[]> = Gate<Has<C, 'textures.read'>, TexturesApi> &
  Gate<Has<C, 'textures.readFile'>, { readonly files: TextureFilesApi }>

/** 按申请的能力裁剪出来的上下文类型。 */
export type PluginContext<C extends readonly Capability[], S, T extends TableMap> = PluginContextBase<S> &
  Gate<Or<Has<C, 'users.read'>, Has<C, 'users.readPrivate'>>, { readonly users: UsersApiFor<C> }> &
  Gate<Has<C, 'users.score'>, { readonly users: UsersScoreApi }> &
  Gate<Has<C, 'players.read'>, { readonly players: PlayersApi }> &
  Gate<Or<Has<C, 'textures.read'>, Has<C, 'textures.readFile'>>, { readonly textures: TexturesApiFor<C> }> &
  Gate<Has<C, 'storage.kv'>, { readonly kv: KvApi }> &
  Gate<Has<C, 'storage.tables'>, { readonly db: PluginDb<T> }>

/**
 * 事务内的拦截器拿到的上下文：只有 `db`（加入核心事务）和不用等核心回应的几项。
 *
 * 没有 `fetch`、`kv`、`jobs`，也不能读核心数据：事务握着数据库的写锁，只等得起本地的数据库操作；
 * 事务整体重跑时 `db` 的写入随之回滚，网络请求、KV 写入和入队却回滚不了。需要的信息都在 `input` 里。
 */
export type TransactionalPluginContext<C extends readonly Capability[], S, T extends TableMap> = PluginContextLocal<S> &
  Gate<Has<C, 'storage.tables'>, { readonly db: PluginDb<T> }>
