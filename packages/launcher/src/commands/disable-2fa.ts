// 关掉用户的两步验证，超级管理员丢了验证器又丢了备用码时用它找回：后台动不了超级管理员（ADR-0036"命令行"）。
//   nextskin disable-2fa <邮箱或 uid>
// 效果同后台关两步验证：删掉验证器和备用码、还没完成的第二步、信任过的设备；不退出登录、不发事件，配置了邮件时通知对方。
// 操作者是 system：不受身份规则限制，照样写审计记录，IP 为空
import type { ReadCommandContext } from '../context.ts'
import { DomainError, openCore } from '@nextskin/domain'

export async function run(argv: string[], read: ReadCommandContext): Promise<number> {
  const [target, ...extra] = argv.filter((arg, index) => !(index === 0 && arg === '--'))

  if (!target || extra.length || target.startsWith('-')) {
    console.error('用法：nextskin disable-2fa <邮箱或 uid>')
    return 1
  } else {
    const context = await read()
    try {
      const opened = await openCore(context.config, { startJobs: false })
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
      return 1
    }
  }
  return 0
}
