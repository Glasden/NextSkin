// 清空页头代码和自定义 CSS，操作者是 system，原文保留在审计里（ADR-0063）。
import type { ReadCommandContext } from '../context.ts'
import { openCore } from '@nextskin/domain'

export async function run(argv: string[], read: ReadCommandContext): Promise<number> {
  const args = argv.filter((arg, index) => !(index === 0 && arg === '--'))

  if (args.length) {
    console.error('用法：nextskin disable-custom-code')
    return 1
  } else {
    const context = await read()
    try {
      const opened = await openCore(context.config, { startJobs: false })
      try {
        const { changed } = await opened.core.admin.clearCustomCodeAsSystem()
        console.log(
          changed
            ? '页头代码和自定义 CSS 已清空，原来的内容记在审计日志里。'
            : '页头代码和自定义 CSS 本来就是空的，没有改动。',
        )
      } finally {
        await opened.close()
      }
    } catch {
      // 不回显配置和数据库的报错原文：里面可能有连接串（不变量 11）。
      console.error('清空自定义代码失败，请检查环境变量和数据库是否可用。')
      return 1
    }
  }
  return 0
}
