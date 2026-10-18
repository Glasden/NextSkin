import { isAbsolute, resolve } from 'node:path'
import type { SnapshotSource } from '@nextskin/db'

/** 旧库的连接。网页表单和命令行各自填这一份；密码只在这次运行的内存里（ADR-0031） */
export type SourceConnection =
  | { dialect: 'sqlite'; file: string }
  | { dialect: 'mysql' | 'postgres'; host: string; port: number; database: string; username: string; password: string }

/** 写进 import_runs.source 和报告的部分：不含密码 */
export type SourceDescription =
  | { dialect: 'sqlite'; file: string }
  | { dialect: 'mysql' | 'postgres'; host: string; port: number; database: string; username: string }

export function describeConnection(connection: SourceConnection): SourceDescription {
  if (connection.dialect === 'sqlite') return { dialect: 'sqlite', file: connection.file }
  return {
    dialect: connection.dialect,
    host: connection.host,
    port: connection.port,
    database: connection.database,
    username: connection.username,
  }
}

export function snapshotSource(connection: SourceConnection): SnapshotSource {
  if (connection.dialect === 'sqlite') return connection
  const url = new URL(`${connection.dialect}://placeholder`)
  url.hostname = connection.host.includes(':') ? `[${connection.host}]` : connection.host
  url.port = String(connection.port)
  url.username = encodeURIComponent(connection.username)
  url.password = encodeURIComponent(connection.password)
  url.pathname = `/${encodeURIComponent(connection.database)}`
  return { dialect: connection.dialect, url: url.toString() }
}

/**
 * 命令行 `--from` 的地址：`mysql://用户:密码@主机:端口/库名`、`postgres://…`，或 `sqlite:<文件>`（相对路径按工作目录）。
 * 格式不对时抛出的错误不回显地址：里面可能有密码
 */
export function parseSourceDsn(dsn: string, cwd: string): SourceConnection {
  if (dsn.startsWith('sqlite:')) {
    const file = dsn.slice('sqlite:'.length)
    if (!file) throw new Error('--from 缺少 SQLite 文件路径；请写成 sqlite:<文件路径>')
    return { dialect: 'sqlite', file: isAbsolute(file) ? file : resolve(cwd, file) }
  }
  let url: URL
  try {
    url = new URL(dsn)
  } catch {
    throw new Error('--from 的格式不对；请使用 mysql://、postgres:// 或 sqlite: 开头的地址')
  }
  const dialect =
    url.protocol === 'mysql:' || url.protocol === 'mariadb:'
      ? 'mysql'
      : url.protocol === 'postgres:' || url.protocol === 'postgresql:'
        ? 'postgres'
        : null
  if (!dialect) throw new Error('--from 的格式不对；请使用 mysql://、postgres:// 或 sqlite: 开头的地址')
  const decode = (value: string) => {
    try {
      return decodeURIComponent(value)
    } catch {
      throw new Error('--from 里的用户名、密码或库名的百分号编码不对')
    }
  }
  const database = decode(url.pathname.slice(1))
  if (!url.hostname || !database) throw new Error('--from 缺少主机名或库名')
  return {
    dialect,
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: url.port ? Number(url.port) : dialect === 'mysql' ? 3306 : 5432,
    database,
    username: decode(url.username),
    password: decode(url.password),
  }
}
