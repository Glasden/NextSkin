import { expect, test } from 'vitest'
import { can, hasAdminAccess, outranks, type CorePermission } from './permissions.ts'

const roles = ['banned', 'user', 'admin', 'superadmin'] as const
const permissions: CorePermission[] = [
  'reports.review',
  'textures.manage',
  'users.ban',
  'users.manage',
  'users.appointAdmin',
  'players.manage',
  'oauthClients.manage',
  'audit.read',
  'settings.manage',
  'import.manage',
  'plugins.manage',
  'jobs.manage',
]
test('固定权限映射与严格角色顺序', () => {
  for (const [i, role] of roles.entries()) {
    expect(hasAdminAccess(role)).toBe(i >= 2)
    for (const permission of permissions)
      expect(can(role, permission)).toBe(
        i === 3 ||
          (i === 2 &&
            !['users.appointAdmin', 'settings.manage', 'import.manage', 'plugins.manage', 'jobs.manage'].includes(
              permission,
            )),
      )
    for (const [j, target] of roles.entries()) expect(outranks(role, target)).toBe(i > j)
  }
})
