import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { coreConfigFromEnv } from '@nextskin/domain/config'
import { instanceDirectory, type CommandContext, type LauncherContext } from './context.ts'

export class ConfigError extends Error {}

/** 目录权限出错时附上当前用户：镜像里以 uid 1000 运行，宝塔以 www 运行，管理员据此 chown（Windows 上为空） */
export function currentUser(): string {
  return process.getuid ? `，当前用户 uid ${process.getuid()}` : ''
}

export function envFilePath(context: LauncherContext, env: NodeJS.ProcessEnv): string {
  return resolve(instanceDirectory(context), env.NEXTSKIN_ENV_FILE ?? '.env')
}

/** 不存在和读不了要分开：只有前者可以在首次启动时生成。 */
export async function readEnvFile(file: string): Promise<{ exists: boolean; values: NodeJS.ProcessEnv }> {
  try {
    return { exists: true, values: parseEnv(await readFile(file, 'utf8')) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ConfigError(`读不了配置文件 ${file}`)
    return { exists: false, values: {} }
  }
}

export function mergeEnv(env: NodeJS.ProcessEnv, values: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const [key, value] of Object.entries(values)) if (env[key] === undefined) env[key] = value
  return env
}

export function listenAddress(env: NodeJS.ProcessEnv): { host: string; port: number } {
  const rawPort = env.NEXTSKIN_PORT ?? env.PORT ?? '3000'
  const port = Number(rawPort)
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new ConfigError('NEXTSKIN_PORT（或 PORT）必须是 1–65535 的整数')
  return { host: env.NEXTSKIN_HOST ?? '0.0.0.0', port }
}

/** 环境变量优先；写回同一个对象，让命令及其依赖读到同一份配置。 */
export async function readConfig(
  context: LauncherContext,
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (message) => console.error(`[nextskin] ${message}`),
): Promise<CommandContext> {
  const file = envFilePath(context, env)
  const { exists, values } = await readEnvFile(file)
  mergeEnv(env, values)
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
      throw new ConfigError(`没法生成 ${file}；请用环境变量 NEXTSKIN_SECRET 给出至少 32 个字符的随机字符串`)
    }
    env.NEXTSKIN_SECRET = secret
    warn(`已生成 ${file}，里面是加密机密设置的密钥。请备份这个文件：丢了它，后台里保存的机密设置都要重新填写。`)
  }
  if (production && env.NEXTSKIN_SECRET && env.NEXTSKIN_SECRET.length < 32)
    throw new ConfigError('NEXTSKIN_SECRET 至少要有 32 个字符；请使用随机字符串')
  let config
  try {
    config = coreConfigFromEnv(env, { cwd: instanceDirectory(context), production })
  } catch (error) {
    // 共享解析器只返回固定的诊断，不含变量的原值。
    throw new ConfigError((error as Error).message)
  }
  const { host, port } = listenAddress(env)
  const childEnv: NodeJS.ProcessEnv = {
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
  delete childEnv.NEXTSKIN_MANAGED
  return { ...context, production, config, env: childEnv, host, port }
}
