// 查看或开关手动维护模式；操作者是 system，照样写审计记录（ADR-0044）。
import type { ReadCommandContext } from '../context.ts'
import { openCore } from '@nextskin/domain'

export async function run(argv: string[], read: ReadCommandContext): Promise<number> {
  const args = argv.filter((arg, index) => !(index === 0 && arg === '--'))
  if (args.length > 1 || (args.length === 1 && args[0] !== 'on' && args[0] !== 'off')) {
    console.error('用法：nextskin maintenance [on|off]')
    return 1
  }
  const context = await read()
  try {
    const opened = await openCore(context.config, { startJobs: false })
    try {
      if (!args.length) {
        const values = await opened.core.settings.read(['maintenance.enabled', 'maintenance.blockProtocols'])
        console.log(
          !values['maintenance.enabled']
            ? '维护模式：未开启'
            : values['maintenance.blockProtocols']
              ? '维护模式：已开启（游戏服务已停用）'
              : '维护模式：已开启（游戏服务照常）',
        )
      } else {
        const enabled = args[0] === 'on'
        const { changed } = await opened.core.admin.setMaintenanceAsSystem(enabled)
        console.log(
          enabled
            ? changed
              ? '维护模式已开启：除了管理员，别人打开站点只能看到维护页。'
              : '维护模式已经开启，没有改动。'
            : changed
              ? '维护模式已关闭。'
              : '维护模式已经关闭，没有改动。',
        )
      }
    } finally {
      await opened.close()
    }
  } catch {
    // 不回显配置和数据库的报错原文：里面可能有连接串（不变量 11）。
    console.error('维护模式命令执行失败，请检查环境变量和数据库是否可用。')
    return 1
  }
  return 0
}
