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
  readonly site: { readonly url: string; readonly name: string }
  /** 当前设置；管理员修改后，下一次调用就能看到新值。 */
  readonly settings: Readonly<S>
  /** 取本插件的翻译。在请求内调用时默认使用当前用户的语言。 */
  t(key: MessageKey, params?: Readonly<Record<string, string | number>>, locale?: string): string
  /** 日志带插件 id，核心不检查内容：不要写密码、令牌、密钥这类机密。 */
  readonly log: Logger
  /** 插件停用、换代或这次调用超时时 abort。长时间运行的操作应该监听它。 */
  readonly signal: AbortSignal
}

/**
 * 插件上下文：插件接触核心的唯一途径。
 *
 * 在插件 host 进程里，这里的每个方法都是一次到核心的 RPC；
 * 对官方插件（在核心进程内运行）则是直接调用，参数和返回值同样序列化一次。插件代码不需要知道区别。
 */
export interface PluginContextBase<S> extends PluginContextLocal<S> {
  readonly jobs: {
    /** name 必须是本插件 `jobs` 中声明的键；载荷序列化后不超过 64 KB */
    enqueue(name: string, payload: Json, options?: { delaySec?: number; dedupeKey?: string }): Promise<void>
  }
  /** 出站 HTTP。只允许访问定义里 `network` 声明过的 origin。 */
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>
}

export interface Logger {
  debug(message: string, fields?: Readonly<Record<string, Json>>): void
  info(message: string, fields?: Readonly<Record<string, Json>>): void
  warn(message: string, fields?: Readonly<Record<string, Json>>): void
  error(message: string, fields?: Readonly<Record<string, Json>>): void
}

export interface UsersPublicApi {
  get(uid: Uid): Promise<PublicUser | null>
  getMany(uids: readonly Uid[]): Promise<PublicUser[]>
}

export interface UsersPrivateApi {
  get(uid: Uid): Promise<PrivateUser | null>
  getMany(uids: readonly Uid[]): Promise<PrivateUser[]>
  findByEmail(email: string): Promise<PrivateUser | null>
}

export interface PlayersApi {
  get(pid: Pid): Promise<Player | null>
  findByName(name: string): Promise<Player | null>
  findByUuid(uuid: string): Promise<Player | null>
  listByUser(uid: Uid): Promise<Player[]>
}

export interface TexturesApi {
  get(tid: Tid): Promise<Texture | null>
  /** 同一 hash 可有多个条目，优先返回公开的，其次取 tid 最小的。 */
  findByHash(hash: string): Promise<Texture | null>
}

export interface TextureFilesApi {
  read(hash: string): Promise<Uint8Array | null>
}

export interface KvApi {
  get<T extends Json>(key: string): Promise<T | null>
  /** 值序列化后不超过 64 KB。`ttlSec` 到期后读到的是 null。 */
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

/**
 * 插件自己的数据库。
 *
 * - 表名写逻辑名（`codes`），核心自动映射到 `p_<插件 id>__codes`。表名只能是小写字母、数字和单个下划线。
 * - 只能访问 `tables` 里声明过的表；不支持原始 SQL（`sql` 模板），核心会拒绝。
 * - 只支持一个 FROM 项加 JOIN；不支持 INSERT…SELECT、CTE；RETURNING 只能用在 INSERT 上；日期参数用 ISO 字符串。
 * - 每条语句单独提交。只有事务内的拦截器例外：那里的语句加入核心事务，随它一起提交或回滚。
 * - 查询在核心进程里重新编译后执行，插件永远拿不到数据库凭据。
 * 完整规则见 docs/adr/0010-plugin-api.md、docs/adr/0033-plugin-system-v1.md 与 spikes/s5-remote-kysely/README.md。
 */
export type PluginDb<T extends TableMap> = Omit<Kysely<RowsOf<T>>, DbOmitted>

/** 迁移里的数据库：多了建表、加列、建索引的 `schema`，同样不能开事务。表名写逻辑名。 */
// 同 Kysely 自己的 Migration：迁移执行时的表结构不一定是现在 `tables` 里声明的样子
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PluginMigrationDb = Omit<Kysely<any>, Exclude<DbOmitted, 'schema'>>

/** 插件表的迁移。只往前走：核心不执行 down，插件也不支持降级。 */
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
