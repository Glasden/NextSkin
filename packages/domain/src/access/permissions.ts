import type { UserRole } from '@nextskin/plugin-sdk'

export type CorePermission =
  | 'reports.review'
  | 'textures.manage'
  | 'users.ban'
  | 'users.appointAdmin'
  | 'audit.read'
  | 'settings.manage'
  | 'import.manage'
const permissions: Record<UserRole, readonly CorePermission[]> = {
  banned: [],
  user: [],
  admin: ['reports.review', 'textures.manage', 'users.ban', 'audit.read'],
  superadmin: [
    'reports.review',
    'textures.manage',
    'users.ban',
    'users.appointAdmin',
    'audit.read',
    'settings.manage',
    'import.manage',
  ],
}
export function can(role: UserRole, permission: CorePermission): boolean {
  return permissions[role].includes(permission)
}
/** 至少有一项后台权限。 */
export function hasAdminAccess(role: UserRole): boolean {
  return permissions[role].length > 0
}
/** 操作者的角色严格高于对象。 */
export function outranks(actor: UserRole, target: UserRole): boolean {
  const ranks: Record<UserRole, number> = { banned: 0, user: 1, admin: 2, superadmin: 3 }
  return ranks[actor] > ranks[target]
}
