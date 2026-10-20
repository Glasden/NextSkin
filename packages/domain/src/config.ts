import { join, resolve } from 'node:path'
import type { DatabaseConfig } from '@nextskin/db'

export interface CoreConfig {
  database: DatabaseConfig
  /** `NEXTSKIN_DATA_DIR`：数据目录，导入器把报告写在这里 */
  dataDirectory: string
  /** SQLite 升级前的备份：`<数据目录>/backups`（ADR-0040） */
  backupDirectory: string
  /** 本地材质存储目录 */
  textureDirectory: string
  renderCacheDirectory: string
  /** 安装插件的包（存储接口的本地驱动）：`<数据目录>/plugin-packages` */
  pluginPackageDirectory: string
  /** 本实例解开的安装插件：`<数据目录>/plugins/{id}/{版本}`（ADR-0009） */
  pluginDirectory: string
  secretKey: string
  production: boolean
}

/** 只在开发环境使用的固定密钥：开发库里的机密设置用它加密，换到生产环境要重新设置 */
const DEVELOPMENT_SECRET = 'nextskin-development-secret-not-for-production'

/**
 * 从环境变量读取配置（ADR-0002：数据库连接和密钥放在 .env，其余设置存在数据库里）。
 *
 * - `NEXTSKIN_DATA_DIR`：数据目录，默认是工作目录下的 `data`。SQLite 文件和材质都放在这里；
 * - `NEXTSKIN_DATABASE_URL`：`mysql://…`、`postgres://…`，或 `sqlite:<文件路径>`（相对路径按工作目录解析），
 *   默认是数据目录下的 `nextskin.sqlite`；
 * - `NEXTSKIN_SECRET`：加密机密设置的密钥，至少 32 个字符。生产环境必须设置。
 */
export function coreConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  options: { cwd: string; production: boolean },
): CoreConfig {
  const dataDirectory = resolve(options.cwd, env.NEXTSKIN_DATA_DIR || 'data')
  const url = env.NEXTSKIN_DATABASE_URL || `sqlite:${join(dataDirectory, 'nextskin.sqlite')}`
  let database: DatabaseConfig
  if (url.startsWith('sqlite:')) {
    const file = url.slice('sqlite:'.length)
    if (!file) throw new Error('NEXTSKIN_DATABASE_URL 缺少 SQLite 文件路径；请写成 sqlite:<文件路径>')
    database = { dialect: 'sqlite', file: resolve(options.cwd, file) }
  } else if (url.startsWith('mysql://')) {
    database = { dialect: 'mysql', url }
  } else if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    database = { dialect: 'postgres', url }
  } else {
    // 不回显变量的值：里面可能有数据库密码（不变量 11）
    throw new Error('NEXTSKIN_DATABASE_URL 的格式不对；请使用 mysql://、postgres:// 或 sqlite: 开头的地址')
  }
  const secretKey = env.NEXTSKIN_SECRET || (options.production ? undefined : DEVELOPMENT_SECRET)
  if (!secretKey) throw new Error('没有设置 NEXTSKIN_SECRET；请在 .env 里写入至少 32 个字符的随机字符串')
  return {
    database,
    dataDirectory,
    backupDirectory: join(dataDirectory, 'backups'),
    textureDirectory: join(dataDirectory, 'textures'),
    renderCacheDirectory: join(dataDirectory, 'render-cache'),
    pluginPackageDirectory: join(dataDirectory, 'plugin-packages'),
    pluginDirectory: join(dataDirectory, 'plugins'),
    secretKey,
    production: options.production,
  }
}
