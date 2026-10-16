/**
 * 插件可以申请的数据访问能力。
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
  /** 调整积分；核心记流水，必须给出原因 */
  'users.score',
  'players.read',
  /** 材质元数据 */
  'textures.read',
  /** 材质 PNG 原始字节 */
  'textures.readFile',
  'notifications.send',
  /** 按插件隔离的 KV 存储（`ctx.kv`） */
  'storage.kv',
  /** 插件自有表（`ctx.db`），表名自动加插件前缀 */
  'storage.tables',
  /** 在主域运行插件自己的前端代码：等同于以当前登录用户（包括管理员）的身份行事 */
  'ui.script',
] as const

export type Capability = (typeof capabilities)[number]

/**
 * 安装界面需要醒目提示的能力。
 * 另外，提供 passwordHasher / login / mail 这几类 Provider 的插件会接触到明文密码、
 * 第三方身份或邮件内容，同样按高风险展示（由核心根据 manifest 判断）。
 */
export const highRiskCapabilities = [
  'users.readPrivate',
  'textures.readFile',
  'ui.script',
] as const satisfies readonly Capability[]

export type Has<C extends readonly Capability[], K extends Capability> = K extends C[number] ? true : false
export type Or<A extends boolean, B extends boolean> = A extends true ? true : B
/** 条件成立时得到 T，否则得到 unknown（与其他类型求交集时不产生任何成员）。 */
export type Gate<B extends boolean, T> = B extends true ? T : unknown
