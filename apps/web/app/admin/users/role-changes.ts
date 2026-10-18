import type { AssignableRole, UserRole } from '@nextskin/domain'

// 服务端组件（用户列表）和客户端组件（管理菜单）共用：不能放在 'use client' 的文件里

export type RoleChange = 'ban' | 'unban' | 'appoint' | 'revoke'

export const roleChangeTargets: Record<RoleChange, AssignableRole> = {
  ban: 'banned',
  unban: 'user',
  appoint: 'admin',
  revoke: 'user',
}

/** 当前角色能改成什么：解封一律回到 user；设为、取消管理员要有 users.appointAdmin（ADR-0027） */
export function roleChanges(role: UserRole, canAppoint: boolean): RoleChange[] {
  if (role === 'banned') return ['unban']
  if (role === 'user') return canAppoint ? ['ban', 'appoint'] : ['ban']
  if (role === 'admin') return canAppoint ? ['ban', 'revoke'] : []
  return []
}
