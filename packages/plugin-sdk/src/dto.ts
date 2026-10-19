/**
 * 插件能看到的核心数据。
 *
 * 规则：
 * - 只暴露这里的 DTO，永远不暴露表结构或内部模型；核心改 schema 时由核心负责映射。
 * - 所有字段必须能结构化克隆并无损转成 JSON（日期一律 ISO 8601 字符串），
 *   因为插件可能运行在另一个进程甚至另一台机器上。
 */

export type Uid = number
export type Pid = number
export type Tid = number
/** ISO 8601，UTC，例如 2026-10-16T08:00:00.000Z */
export type IsoDateTime = string

export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json }

/** 次版本可能加成员，插件要处理不认识的值。 */
export type UserRole = 'banned' | 'user' | 'admin' | 'superadmin' | (string & {})

/** `users.read` 可见。 */
export interface PublicUser {
  readonly uid: Uid
  readonly nickname: string
  readonly role: UserRole
  readonly avatarTid: Tid | null
  readonly registeredAt: IsoDateTime
}

/** `users.readPrivate` 额外可见。 */
export interface PrivateUser extends PublicUser {
  readonly email: string
  readonly emailVerified: boolean
  readonly score: number
  readonly locale: string | null
}

export interface Player {
  readonly pid: Pid
  readonly uid: Uid
  readonly name: string
  /** Yggdrasil 角色 UUID，32 位小写十六进制、无连字符。创建后永不改变。 */
  readonly uuid: string
  readonly skin: Tid | null
  readonly cape: Tid | null
  readonly updatedAt: IsoDateTime
}

/** 次版本可能加成员，插件要处理不认识的值。 */
export type TextureType = 'steve' | 'alex' | 'cape' | (string & {})

export interface Texture {
  readonly tid: Tid
  readonly name: string
  readonly type: TextureType
  /**
   * 新材质是像素 hash：sha256(u32be(宽) ‖ u32be(高) ‖ RGBA8 像素)；从 BS 导入的旧材质保留原来的 hash。
   * 同时是存储键和公开 URL `/textures/{hash}` 的一部分。插件不应自己计算或解析它。
   */
  readonly hash: string
  readonly width: number
  readonly height: number
  readonly sizeBytes: number
  readonly uploader: Uid | null
  readonly description: string | null
  readonly public: boolean
  readonly likes: number
  readonly uploadedAt: IsoDateTime
}

export type Actor =
  | { readonly kind: 'user'; readonly uid: Uid; readonly role: UserRole }
  | { readonly kind: 'system' }
  /** 第一版核心不会产生它；写核心数据的能力落地后才会出现。 */
  | { readonly kind: 'plugin'; readonly pluginId: string }

export type UserActor = Extract<Actor, { kind: 'user' }>

/**
 * 插件通过 `ui.formFields` 加到核心表单里的字段值。
 * 核心只把**本插件**贡献的字段传给本插件，键名就是字段的 `name`。
 * 文本统一 trim，默认最多 1000 字符，禁止 NUL，空值省略；boolean 转成 "true"/"false"，required boolean 必须为 true。
 * 插件自己的 form/Action 则提交 JSON 数字和布尔值。
 */
export type ExtraFields = Readonly<Record<string, string>>
