import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { coreConfigFromEnv } from '@nextskin/domain/config'
import type { CommandContext, LauncherContext } from './context.ts'

export class ConfigError extends Error {}

/** 环境变量优先；写回同一个对象，让命令及其依赖读到同一份配置。 */
export async function readConfig(
  context: LauncherContext,
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = console.error,
): Promise<CommandContext> {
  const file = resolve(context.root, env.NEXTSKIN_ENV_FILE ?? '.env')
  let exists = true
  let values: NodeJS.ProcessEnv
  try {
    values = parseEnv(await readFile(file, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ConfigError(`读不了配置文件 ${file}`)
    exists = false
    values = {}
  }
  for (const [key, value] of Object.entries(values)) if (env[key] === undefined) env[key] = value
  const production = !context.source || env.NODE_ENV === 'production'
  if (!context.source && !env.NEXTSKIN_SECRET) {
    if (exists)
      throw new ConfigError(`${file} 里没有 NEXTSKIN_SECRET；请加上一行 NEXTSKIN_SECRET=<至少 32 个字符的随机字符串>`)
    const secret = randomBytes(32).toString('base64url')
    try {
      await writeFile(file, `# 用于加密机密设置，请备份这个文件。\nNEXTSKIN_SECRET=${secret}\n`, {
        mode: 0o600,
        flag: 'wx',
      })
    } catch {
      throw new ConfigError(
        `没法在 ${context.root} 生成 .env；请用环境变量 NEXTSKIN_SECRET 给出至少 32 个字符的随机字符串`,
      )
    }
    env.NEXTSKIN_SECRET = secret
    warn(
      `[nextskin] 已生成 ${file}，里面是加密机密设置的密钥。请备份这个文件：丢了它，后台里保存的机密设置都要重新填写。`,
    )
  }
  if (production && env.NEXTSKIN_SECRET && env.NEXTSKIN_SECRET.length < 32)
    throw new ConfigError('NEXTSKIN_SECRET 至少要有 32 个字符；请使用随机字符串')
  let config
  try {
    config = coreConfigFromEnv(env, { cwd: context.root, production })
  } catch (error) {
    // 共享解析器只返回固定的诊断，不含变量的原值。
    throw new ConfigError((error as Error).message)
  }
  const rawPort = env.NEXTSKIN_PORT ?? env.PORT ?? '3000'
  const port = Number(rawPort)
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new ConfigError('NEXTSKIN_PORT（或 PORT）必须是 1–65535 的整数')
  const host = env.NEXTSKIN_HOST ?? '0.0.0.0'
  const childEnv = {
    ...env,
    NODE_ENV: 'production',
    // 核心进程据此打开和启动器之间的控制通道（apps/web/lib/launcher-channel.ts）
    NEXTSKIN_LAUNCHER_IPC: '1',
    HOSTNAME: host,
    PORT: String(port),
    NEXTSKIN_ENV_FILE: file,
    NEXTSKIN_DATA_DIR: config.dataDirectory,
    NEXTSKIN_DATABASE_URL:
      config.database.dialect === 'sqlite' ? `sqlite:${config.database.file}` : config.database.url,
  }
  return { ...context, production, config, env: childEnv, host, port }
}
