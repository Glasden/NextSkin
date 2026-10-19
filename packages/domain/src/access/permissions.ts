import type { UserRole } from '@nextskin/db'

export type CorePermission =
  | 'reports.review'
  | 'textures.manage'
  | 'users.ban'
  | 'users.manage'
  | 'users.appointAdmin'
  | 'players.manage'
  | 'audit.read'
  | 'settings.manage'
  | 'import.manage'
  | 'plugins.manage'
const permissions: Record<UserRole, readonly CorePermission[]> = {
  banned: [],
  user: [],
  admin: ['reports.review', 'textures.manage', 'users.ban', 'users.manage', 'players.manage', 'audit.read'],
  superadmin: [
    'reports.review',
    'textures.manage',
    'users.ban',
    'users.manage',
    'users.appointAdmin',
    'players.manage',
    'audit.read',
    'settings.manage',
    'import.manage',
    'plugins.manage',
  ],
}
export function can(role: UserRole, permission: CorePermission): boolean {
  return permissions[role].includes(permission)
}
/** 插件声明的权限：第一版没有授予普通用户的办法，管理员和超级管理员拥有全部插件权限（ADR-0027） */
export function canPlugin(role: UserRole): boolean {
  return role === 'admin' || role === 'superadmin'
}
/** 至少有一项后台权限。 */
export function hasAdminAccess(role: UserRole): boolean {
  return permissions[role].length > 0
}
/** 操作者的身份严格高于对象（ADR-0027、ADR-0036：后台只能管理身份比自己低的用户）。 */
export function outranks(actor: UserRole, target: UserRole): boolean {
  const ranks: Record<UserRole, number> = { banned: 0, user: 1, admin: 2, superadmin: 3 }
  return ranks[actor] > ranks[target]
}
