/**
 * 插件可以申请的数据访问能力。除 `users.score` 和 `notifications.send` 外只读核心数据或读写插件自己的数据。
 * 写核心数据的能力一项对应一个领域用例（ADR-0041）。
 *
 * 这里只列"从贡献清单看不出来"的权限。注册了哪些路由、事件、拦截器、Provider、UI，
 * 本身就写在 manifest 里，不需要再申请。下面每一项都会在安装时逐条展示给管理员。
 *
 * 没申请的能力在类型上就不存在：`ctx.db` 只在申请了 `storage.tables` 时才有，
 * 运行时核心也会拒绝对应的 RPC。
 */
export const capabilities = [
  /** 公开资料：uid、昵称、角色、头像 */
  'users.read',
  /** 额外可见：邮箱、积分、语言 */
  'users.readPrivate',
  /** 给任何用户加减积分（`ctx.users.adjustScore`），返回值里带余额；写核心数据，安装时按高风险展示（ADR-0041） */
  'users.score',
  /** 给任何用户发站内通知，内容是插件自己的文案；写核心数据，安装时按高风险展示（ADR-0052） */
  'notifications.send',
  'players.read',
  /** 材质元数据 */
  'textures.read',
  /** 材质 PNG 原始字节 */
  'textures.readFile',
  /** 按插件隔离的 KV 存储（`ctx.kv`） */
  'storage.kv',
  /** 插件自有表（`ctx.db`），表名自动加插件前缀 */
  'storage.tables',
] as const

export type Capability = (typeof capabilities)[number]

export type Has<C extends readonly Capability[], K extends Capability> = K extends C[number] ? true : false
export type Or<A extends boolean, B extends boolean> = A extends true ? true : B
/** 条件成立时得到 T，否则得到 unknown（与其他类型求交集时不产生任何成员）。 */
export type Gate<B extends boolean, T> = B extends true ? T : unknown
