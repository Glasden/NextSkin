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
