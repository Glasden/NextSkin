// 关掉用户的两步验证，超级管理员丢了验证器又丢了备用码时用它找回：后台动不了超级管理员（ADR-0036"命令行"）。
//   pnpm disable-2fa <邮箱或 uid>
// 读和 `pnpm dev` 相同的环境变量（packages/domain/src/bootstrap.ts），工作目录是 apps/web。
// 效果同后台关两步验证：删掉验证器和备用码、还没完成的第二步、信任过的设备；不退出登录、不发事件，配置了邮件时通知对方。
// 操作者是 system：不受身份规则限制，照样写审计记录，IP 为空
import { coreConfigFromEnv, DomainError, openCore } from '@nextskin/domain'

const [target, ...extra] = process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === '--'))

if (!target || extra.length || target.startsWith('-')) {
  console.error('用法：pnpm disable-2fa <邮箱或 uid>')
  process.exitCode = 1
} else {
  try {
    const config = coreConfigFromEnv(process.env, {
      cwd: process.cwd(),
      production: process.env.NODE_ENV === 'production',
    })
    const opened = await openCore(config, { startJobs: false })
    try {
      const user = await opened.core.admin.disableTwoFactorAsSystem(target)
      console.log(`${user.nickname}（UID ${user.uid}）的两步验证已关闭，登录不再需要验证码；对方已有的登录没有退出。`)
    } finally {
      await opened.close()
    }
  } catch (error) {
    // 不回显配置和数据库的报错原文：里面可能有连接串（不变量 11）
    console.error(
      error instanceof DomainError && error.code === 'user_not_found'
        ? '没有找到这个用户：检查 UID 或邮箱。'
        : error instanceof DomainError && error.code === 'email_invalid'
          ? '邮箱的格式不对。'
          : '关闭两步验证失败，请检查环境变量和数据库是否可用。',
    )
    process.exitCode = 1
  }
}
