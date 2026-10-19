import type { IsoTimestamp } from '@nextskin/db'
import type { TextureType, UserRole } from '@nextskin/db'

export interface AdminActor {
  uid: number
  ip: string | null
}
export type ReportAction = 'dismiss' | 'deleteTexture' | 'banUploader'
export type AssignableRole = 'banned' | 'user' | 'admin'
export interface AdminReport {
  id: number
  status: 'pending' | 'resolved' | 'rejected'
  resolution: 'dismissed' | 'textureDeleted' | 'uploaderBanned' | null
  reason: string
  scorePaid: number
  createdAt: IsoTimestamp
  resolvedAt: IsoTimestamp | null
  texture: {
    tid: number
    name: string
    type: TextureType
    hash: string
    scale: number
    public: boolean
    likes: number
    /** 这个材质上待处理的举报数（含这一条）：删除时一并采纳 */
    pendingReports: number
  } | null
  uploader: { uid: number; nickname: string; role: UserRole } | null
  reporter: { uid: number; nickname: string } | null
  /**
   * 处理人。处理人的账号删除后 resolver_id 会被置空，这时从审计记录里找回 uid，nickname 为 null；
   * 仍然为 null 的已采纳举报，是上传者自己删除材质时结案的（ADR-0027）
   */
  resolver: { uid: number; nickname: string | null } | null
}
export interface AdminUser {
  uid: number
  nickname: string
  email: string
  emailVerified: boolean
  role: UserRole
  score: number
  registeredAt: IsoTimestamp
  avatar: { hash: string; scale: number } | null
}
export interface AuditEntry {
  id: number
  action: string
  createdAt: IsoTimestamp
  ip: string | null
  actor:
    { type: 'user'; uid: number; nickname: string | null } | { type: 'system' } | { type: 'plugin'; pluginId: string }
  subject: { type: string; id: number; exists: boolean }
  details: Record<string, unknown>
}
export interface AdminOverview {
  pendingReports: number
  users: number
  textures: number
  registeredToday: number
  recentAudit: AuditEntry[]
}

/** 后台改用户的 PATCH：至少一项，每项各按自己的权限检查（ADR-0036"昵称和邮箱验证状态"） */
export interface AdminUserUpdate {
  role?: AssignableRole
  nickname?: string
  emailVerified?: boolean
  /** emailVerified 为 true 时必填：页面上显示、管理员核实过的地址，锁住之后和现在的邮箱比较 */
  expectedEmail?: string
}
export type AdminEmailChangeResult =
  { status: 'pending'; pendingEmail: string } | { status: 'changed'; user: AdminUser }
/** 作废在途的登录删掉的网页会话数和启动器令牌数 */
export type { RevokedLogins } from '../auth/revoke.ts'
export interface AdminSetPasswordInput {
  password: string
  /** 收回账号：删掉全部通行密钥、解绑全部第三方账号（包括插件停用了的） */
  removeOtherMethods?: boolean
  /** 收回账号：邮箱立即换成这个地址，算已验证，不发确认链接 */
  newEmail?: string
}
/** 删除用户时公开材质的去留：默认留下（ADR-0025），delete 还要有 textures.manage */
export type PublicTexturesOnDelete = 'keep' | 'delete'
/** 用户详情页（ADR-0036"页面"）。两步验证的备用码数和第三方绑定由页面另外经 auth.security、externalLogin.accounts 读 */
export interface AdminUserDetail {
  user: AdminUser & { locale: string | null; twoFactorEnabled: boolean }
  /** 最近 10 条积分流水 */
  recentScore: { id: number; delta: number; balance: number; reason: string; createdAt: IsoTimestamp }[]
  hasPassword: boolean
  counts: {
    /** 未过期的网页会话 */
    sessions: number
    /** 未过期的启动器令牌 */
    launcherTokens: number
    passkeys: number
    players: number
    publicTextures: number
    privateTextures: number
    closetItems: number
    oauthClients: number
  }
  /** 名下角色，按 pid 升序，最多 100 个；总数见 counts.players */
  players: { pid: number; name: string; uuid: string }[]
  /** 以这个用户为对象的最近 10 条审计 */
  recentAudit: AuditEntry[]
}

/** 后台角色页的一行（ADR-0036"后台的角色管理"） */
export interface AdminPlayer {
  pid: number
  name: string
  uuid: string
  /** 主人创建时实付的积分；转让的确认框写明不退 */
  scorePaid: number
  updatedAt: IsoTimestamp
  owner: { uid: number; nickname: string; role: UserRole }
  /** 材质文件的尺寸认不出时也给出 tid，scale 为 null，页面只显示编号 */
  skin: { tid: number; hash: string; type: TextureType; scale: number | null } | AdminHiddenTexture | null
  cape: { tid: number; hash: string; scale: number | null } | AdminHiddenTexture | null
}
/** 别人的私有材质：操作者没有 textures.manage 时只给出 tid，页面只显示"私有材质"和编号（ADR-0036"别人的材质"） */
export interface AdminHiddenTexture {
  tid: number
  hidden: true
}
/** 后台改角色的 PATCH：至少一项；skin、cape 为 null 清空 */
export interface AdminPlayerUpdate {
  name?: string
  skin?: number | null
  cape?: number | null
}
/** 转让时按 uid 或邮箱查新主人；没有 users.ban 时 email 为 null（ADR-0036"接口"） */
export interface AdminUserLookup {
  uid: number
  nickname: string
  email: string | null
  role: UserRole
  avatar: { hash: string; scale: number } | null
}
/**
 * 按 tid 查材质、判断某个主人能不能用（ADR-0036"接口"）。别人的私有材质在操作者没有 textures.manage 时
 * 只给出 tid、public 和 visibleToOwner
 */
export type AdminTextureForOwner =
  | {
      tid: number
      name: string
      type: TextureType
      public: boolean
      uploaderId: number | null
      hash: string
      /** 预览用；材质文件的尺寸认不出时为 null */
      scale: number | null
      visibleToOwner: boolean
    }
  | { tid: number; public: false; visibleToOwner: boolean }
