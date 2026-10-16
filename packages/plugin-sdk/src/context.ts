import type { Kysely } from 'kysely'
import type { Capability, Gate, Has, Or } from './capabilities'
import type { Json, Pid, Player, PrivateUser, PublicUser, Texture, Tid, Uid } from './dto'
import type { MessageKey } from './ui'

/**
 * 插件上下文：插件接触核心的唯一途径。
 *
 * 在插件 host 进程里，这里的每个方法都是一次到核心的 RPC；
 * 对官方插件（在核心进程内运行）则是直接调用。插件代码不需要知道区别。
 */
export interface PluginContextBase<S> {
  readonly plugin: { readonly id: string; readonly version: string }
  readonly site: { readonly url: string; readonly name: string }
  /** 当前设置；管理员修改后，下一次调用就能看到新值。 */
  readonly settings: Readonly<S>
  /** 取本插件的翻译。在请求内调用时默认使用当前用户的语言。 */
  t(key: MessageKey, params?: Readonly<Record<string, string | number>>, locale?: string): string
  readonly log: Logger
  /** 插件停用或换代时 abort。长时间运行的操作应该监听它。 */
  readonly signal: AbortSignal
  readonly jobs: {
    /** name 必须是本插件 `jobs` 中声明的键 */
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

export interface UsersScoreApi {
  /** 原子地增减积分并记流水。积分不足以扣减时抛错，不会扣成负数。 */
  adjustScore(uid: Uid, delta: number, reason: MessageKey): Promise<{ score: number }>
}

export interface PlayersApi {
  get(pid: Pid): Promise<Player | null>
  findByName(name: string): Promise<Player | null>
  findByUuid(uuid: string): Promise<Player | null>
  listByUser(uid: Uid): Promise<Player[]>
}

export interface TexturesApi {
  get(tid: Tid): Promise<Texture | null>
  findByHash(hash: string): Promise<Texture | null>
}

export interface TextureFilesApi {
  read(hash: string): Promise<Uint8Array | null>
}

export interface NotificationsApi {
  /** 标题和正文用 i18n 键，由核心按每个收件人的语言渲染；正文按 Markdown 处理。 */
  send(args: {
    to: Uid | readonly Uid[] | 'admins'
    title: MessageKey
    body: MessageKey
    params?: Readonly<Record<string, string | number>>
  }): Promise<void>
}

export interface KvApi {
  get<T extends Json>(key: string): Promise<T | null>
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
 * 插件自己的数据库。
 *
 * - 表名写逻辑名（`codes`），核心自动映射到 `p_<插件 id>__codes`。表名只能是小写字母、数字和单个下划线。
 * - 只能访问 `tables` 里声明过的表；不支持原始 SQL（`sql` 模板），核心会拒绝。
 * - 只支持一个 FROM 项加 JOIN；不支持 INSERT…SELECT、CTE；RETURNING 只能用在 INSERT 上；日期参数用 ISO 字符串。
 * - 查询在核心进程里重新编译后执行，插件永远拿不到数据库凭据。
 * 完整规则见 docs/adr/0010-plugin-api.md 与 spikes/s5-remote-kysely/README.md。
 */
export type PluginDb<T extends TableMap> = Kysely<RowsOf<T>>

type UsersApiFor<C extends readonly Capability[]> = (Has<C, 'users.readPrivate'> extends true
  ? UsersPrivateApi
  : Gate<Has<C, 'users.read'>, UsersPublicApi>) &
  Gate<Has<C, 'users.score'>, UsersScoreApi>

type TexturesApiFor<C extends readonly Capability[]> = Gate<Has<C, 'textures.read'>, TexturesApi> &
  Gate<Has<C, 'textures.readFile'>, { readonly files: TextureFilesApi }>

/** 按申请的能力裁剪出来的上下文类型。 */
export type PluginContext<C extends readonly Capability[], S, T extends TableMap> = PluginContextBase<S> &
  Gate<
    Or<Or<Has<C, 'users.read'>, Has<C, 'users.readPrivate'>>, Has<C, 'users.score'>>,
    { readonly users: UsersApiFor<C> }
  > &
  Gate<Has<C, 'players.read'>, { readonly players: PlayersApi }> &
  Gate<Or<Has<C, 'textures.read'>, Has<C, 'textures.readFile'>>, { readonly textures: TexturesApiFor<C> }> &
  Gate<Has<C, 'notifications.send'>, { readonly notifications: NotificationsApi }> &
  Gate<Has<C, 'storage.kv'>, { readonly kv: KvApi }> &
  Gate<Has<C, 'storage.tables'>, { readonly db: PluginDb<T> }>
