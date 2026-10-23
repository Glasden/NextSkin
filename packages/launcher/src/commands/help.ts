import type { LauncherContext } from '../context.ts'

export function run(_argv: string[], context: LauncherContext): number {
  console.log(`用法：${context.source ? 'pnpm nextskin' : 'node nextskin.mjs'} <命令>

  start                    启动并监管核心进程
  migrate                  执行核心和已启用官方插件的迁移
  doctor                   检查运行环境
  set-role                 设定用户身份
  set-password             重设用户密码、收回账号
  disable-2fa              关闭用户的两步验证
  disable-captcha          关闭站点验证码
  maintenance [on|off]     查看或开关手动维护模式
  plugin <子命令>          管理插件：list、install、enable、disable、uninstall
  import blessing-skin     从 Blessing Skin v6 导入
  version                  显示版本
  help                     显示帮助

doctor、migrate 加 --json 输出机器可读的结果，供升级流程使用。`)
  return 0
}
