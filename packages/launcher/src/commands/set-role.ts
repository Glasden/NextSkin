// 设定用户的身份（`users.role`），例如另指定一个超级管理员（ADR-0027）。
//   nextskin set-role <邮箱> <身份>
// 操作者是 system：不受身份规则限制，可以设为 superadmin；照样写审计记录，IP 为空
import type { ReadCommandContext } from '../context.ts'
import { DomainError, openCore, type UserRole } from '@nextskin/domain'

export async function run(argv: string[], read: ReadCommandContext): Promise<number> {
  const roles: readonly UserRole[] = ['banned', 'user', 'admin', 'superadmin']
  const [email, role, ...extra] = argv

  if (!email || !role || extra.length || !(roles as readonly string[]).includes(role)) {
    console.error(`用法：nextskin set-role <邮箱> <身份>；身份是 ${roles.join('、')} 之一。`)
    return 1
  } else {
    const context = await read()
    try {
      const opened = await openCore(context.config, { startJobs: false })
      try {
        const user = await opened.core.admin.setRoleAsSystem(email, role as UserRole)
        console.log(`已把 ${user.nickname}（UID ${user.uid}）的身份设为 ${user.role}。`)
      } finally {
        await opened.close()
      }
    } catch (error) {
      // 不回显配置和数据库的报错原文：里面可能有连接串（不变量 11）
      console.error(
        error instanceof DomainError && error.code === 'user_not_found'
          ? '没有用这个邮箱注册的用户。'
          : error instanceof DomainError && error.code === 'email_invalid'
            ? '邮箱的格式不对。'
            : '设定身份失败，请检查环境变量和数据库是否可用。',
      )
      return 1
    }
  }
  return 0
}
