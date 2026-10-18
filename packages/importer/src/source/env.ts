// 旧站的 .env（Laravel 用 vlucas/phpdotenv 读它）。只取导入要用的几项：数据库连接、表前缀、密码算法、盐、材质目录
import { isAbsolute, resolve } from 'node:path'
import type { SourceConnection } from './connection.ts'

/**
 * 按 phpdotenv 的常用写法解析：`KEY=value`、可选的 `export ` 前缀、`#` 开头的注释行；
 * 单引号原样，双引号支持反斜杠转义（引号、反斜杠、换行等）和 `${VAR}` 引用；不加引号的值去掉行尾的 ` #` 注释和首尾空白，
 * 也展开 `${VAR}`。不认识的行跳过
 */
export function parseDotenv(text: string): Record<string, string> {
  const result: Record<string, string> = {}
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    const key = match[1]!
    let raw = match[2]!
    if (raw.startsWith("'")) {
      let value = raw.slice(1)
      // 单引号的值可以跨行
      while (!value.includes("'") && index + 1 < lines.length) value += '\n' + lines[++index]!
      const end = value.indexOf("'")
      result[key] = end >= 0 ? value.slice(0, end) : value
    } else if (raw.startsWith('"')) {
      let body = raw.slice(1)
      let end = closingQuote(body)
      while (end < 0 && index + 1 < lines.length) {
        body += '\n' + lines[++index]!
        end = closingQuote(body)
      }
      const quoted = end >= 0 ? body.slice(0, end) : body
      const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', f: '\f', v: '\v' }
      // 转义和 ${VAR} 一遍处理，转义出来的 $ 不会再被当作引用
      result[key] = quoted.replace(
        /\\([\\"nrtfv$])|\$\{([A-Za-z_][A-Za-z0-9_.]*)\}/g,
        (_, escaped: string | undefined, name: string | undefined) =>
          escaped !== undefined ? (escapes[escaped] ?? escaped) : (result[name!] ?? ''),
      )
    } else {
      raw = raw.replace(/\s+#.*$/, '').trim()
      result[key] = interpolate(raw, result)
    }
  }
  return result
}

function closingQuote(body: string): number {
  for (let index = 0; index < body.length; index++) {
    if (body[index] === '\\') index++
    else if (body[index] === '"') return index
  }
  return -1
}

function interpolate(value: string, defined: Record<string, string>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_.]*)\}/g, (_, name: string) => defined[name] ?? '')
}

export interface BsEnvironment {
  /** DB_CONNECTION 等几项；没写全时为 null，由调用方另外提供 */
  connection: SourceConnection | null
  prefix: string
  /** PWD_METHOD，没写时为 null（BS 的默认是 BCRYPT） */
  passwordMethod: string | null
  salt: string
  /** TEXTURES_DIR，相对路径按 .env 所在目录解析；没写时是 BS 的默认位置 storage/textures */
  texturesDirectory: string | null
  /** FS_DRIVER 不是 local 时，材质不在本地磁盘上，要先同步到本地目录 */
  localTextures: boolean
}

/** directory 是 .env 所在的目录，也就是 BS 的根目录 */
export function readBsEnvironment(env: Record<string, string>, directory: string | null): BsEnvironment {
  const value = (key: string) => env[key]?.trim() || null
  const connection = connectionFromEnv(env, directory)
  const textures = value('TEXTURES_DIR')
  return {
    connection,
    prefix: env.DB_PREFIX?.trim() ?? '',
    passwordMethod: value('PWD_METHOD'),
    salt: env.SALT ?? '',
    texturesDirectory: textures
      ? isAbsolute(textures)
        ? textures
        : directory
          ? resolve(directory, textures)
          : null
      : directory
        ? resolve(directory, 'storage', 'textures')
        : null,
    localTextures: (value('FS_DRIVER') ?? 'local') === 'local',
  }
}

function connectionFromEnv(env: Record<string, string>, directory: string | null): SourceConnection | null {
  const driver = env.DB_CONNECTION?.trim() || 'mysql'
  const database = env.DB_DATABASE?.trim()
  if (driver === 'sqlite') {
    // Laravel 的默认值是 database/database.sqlite
    const file = database || (directory ? resolve(directory, 'database', 'database.sqlite') : null)
    if (!file || (!isAbsolute(file) && !directory)) return null
    return { dialect: 'sqlite', file: isAbsolute(file) ? file : resolve(directory!, file) }
  }
  if (driver !== 'mysql' && driver !== 'pgsql') return null
  if (!database) return null
  const port = Number(env.DB_PORT?.trim() || (driver === 'mysql' ? 3306 : 5432))
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return null
  return {
    dialect: driver === 'mysql' ? 'mysql' : 'postgres',
    host: env.DB_HOST?.trim() || '127.0.0.1',
    port,
    database,
    username: env.DB_USERNAME?.trim() ?? '',
    password: env.DB_PASSWORD ?? '',
  }
}
