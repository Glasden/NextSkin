// 设定用户的角色，例如站点的第一个超级管理员（ADR-0027）。安装向导和启动器的 `user` 子命令落地后，调用的是同一个用例。
//   pnpm set-role <邮箱> <角色>
// 读和 `pnpm dev` 相同的环境变量（packages/domain/src/bootstrap.ts），工作目录是 apps/web。
// 操作者是 system：不受角色规则限制，可以设为 superadmin；照样写审计记录，IP 为空
import { coreConfigFromEnv, DomainError, openCore, type UserRole } from '@nextskin/domain'

const roles: readonly UserRole[] = ['banned', 'user', 'admin', 'superadmin']
const [email, role, ...extra] = process.argv.slice(2)

if (!email || !role || extra.length || !(roles as readonly string[]).includes(role)) {
  console.error(`用法：pnpm set-role <邮箱> <角色>；角色是 ${roles.join('、')} 之一。`)
  process.exitCode = 1
} else {
  try {
    const config = coreConfigFromEnv(process.env, {
      cwd: process.cwd(),
      production: process.env.NODE_ENV === 'production',
    })
    const opened = await openCore(config, { startJobs: false })
    try {
      const user = await opened.core.admin.setRoleAsSystem(email, role as UserRole)
      console.log(`已把 ${user.nickname}（UID ${user.uid}）的角色设为 ${user.role}。`)
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
          : '设定角色失败，请检查环境变量和数据库是否可用。',
    )
    process.exitCode = 1
  }
}
