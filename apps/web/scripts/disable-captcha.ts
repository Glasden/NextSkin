// 关掉验证码，服务商故障或密钥配错、超级管理员登录不了时用（ADR-0038）。
//   pnpm disable-captcha
// 读和 `pnpm dev` 相同的环境变量（packages/domain/src/bootstrap.ts），工作目录是 apps/web。
// 把 captcha.provider 设为 none；操作者是 system，照样写审计记录，IP 为空。
import { coreConfigFromEnv, openCore } from '@nextskin/domain'

const args = process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === '--'))

if (args.length) {
  console.error('用法：pnpm disable-captcha')
  process.exitCode = 1
} else {
  try {
    const config = coreConfigFromEnv(process.env, {
      cwd: process.cwd(),
      production: process.env.NODE_ENV === 'production',
    })
    const opened = await openCore(config, { startJobs: false })
    try {
      const { changed } = await opened.core.admin.disableCaptchaAsSystem()
      console.log(changed ? '验证码已关闭，注册、密码登录和找回密码不再需要验证码。' : '验证码已经关闭，没有改动。')
    } finally {
      await opened.close()
    }
  } catch {
    // 不回显配置和数据库的报错原文：里面可能有连接串（不变量 11）。
    console.error('关闭验证码失败，请检查环境变量和数据库是否可用。')
    process.exitCode = 1
  }
}
