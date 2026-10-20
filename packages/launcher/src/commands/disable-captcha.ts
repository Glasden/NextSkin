// 关掉验证码，服务商故障或密钥配错、超级管理员登录不了时用（ADR-0038）。
//   nextskin disable-captcha
// 把 captcha.provider 设为 none；操作者是 system，照样写审计记录，IP 为空。
import type { ReadCommandContext } from '../context.ts'
import { openCore } from '@nextskin/domain'

export async function run(argv: string[], read: ReadCommandContext): Promise<number> {
  const args = argv.filter((arg, index) => !(index === 0 && arg === '--'))

  if (args.length) {
    console.error('用法：nextskin disable-captcha')
    return 1
  } else {
    const context = await read()
    try {
      const opened = await openCore(context.config, { startJobs: false })
      try {
        const { changed } = await opened.core.admin.disableCaptchaAsSystem()
        console.log(changed ? '验证码已关闭，注册、密码登录和找回密码不再需要验证码。' : '验证码已经关闭，没有改动。')
      } finally {
        await opened.close()
      }
    } catch {
      // 不回显配置和数据库的报错原文：里面可能有连接串（不变量 11）。
      console.error('关闭验证码失败，请检查环境变量和数据库是否可用。')
      return 1
    }
  }
  return 0
}
