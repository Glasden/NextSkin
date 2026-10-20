import type { LauncherContext } from '../context.ts'

export function run(_argv: string[], context: LauncherContext): number {
  console.log(`用法：${context.source ? 'pnpm nextskin' : 'node nextskin.mjs'} <命令>

  start                    启动并监管核心进程
  migrate                  执行核心数据库迁移
  set-role                 设定用户身份
  set-password             重设用户密码、收回账号
  disable-2fa              关闭用户的两步验证
  disable-captcha          关闭站点验证码
  import blessing-skin     从 Blessing Skin v6 导入
  version                  显示版本
  help                     显示帮助`)
  return 0
}
