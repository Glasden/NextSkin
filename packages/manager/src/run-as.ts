import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process'
import { chown, stat } from 'node:fs/promises'
import { ConfigError } from './types.ts'

export interface RunAs {
  name: string
  uid: number
  gid: number
}
export interface RunAsOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  getuid?: () => number
  execFileSync?: (
    file: string,
    args: readonly string[],
    options: ExecFileSyncOptionsWithStringEncoding,
  ) => string | Buffer
  runAs?: RunAs
  chown?: typeof chown
  stat?: (file: string) => Promise<{ uid: number; mode: number }>
}
export function resolveRunAs(options: RunAsOptions = {}): RunAs | undefined {
  const name = (options.env ?? process.env).NEXTSKIN_RUN_AS
  if (name === undefined) return
  if ((options.platform ?? process.platform) === 'win32') throw new ConfigError('Windows 不支持 NEXTSKIN_RUN_AS')
  if (!/^[a-z_][a-z0-9_-]{0,31}\$?$/i.test(name)) throw new ConfigError('NEXTSKIN_RUN_AS 必须是合法的 POSIX 用户名')
  const id = (flag: '-u' | '-g') => {
    let value: string
    try {
      value = String(
        (options.execFileSync ?? execFileSync)('id', [flag, name], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }),
      ).trim()
    } catch {
      throw new ConfigError('无法通过 id 解析 NEXTSKIN_RUN_AS 的用户和组')
    }
    const number = Number(value)
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number > 0xfffffffe)
      throw new ConfigError('id 返回的用户或组编号不合法')
    return number
  }
  const uid = id('-u')
  const gid = id('-g')
  const own = (options.getuid ?? process.getuid)?.()
  if (uid === own) return
  if (own !== 0) throw new ConfigError('降权要以 root 运行管理进程')
  return { name, uid, gid }
}
export function logRunAs(runAs: RunAs | undefined, log: (message: string) => void = console.error): void {
  if (runAs) log(`[nextskin] 以 ${runAs.name}（${runAs.uid}/${runAs.gid}）运行服务`)
}

/** root 没降权时，迁移会在服务用户的数据目录里留下 root 的文件；只给命令行离线执行的流水线用（ManagerOptions.checkDataOwner）。 */
export async function assertDataOwner(directory: string, options: RunAsOptions = {}): Promise<void> {
  if (options.runAs || (options.getuid ?? process.getuid)?.() !== 0) return
  let owner: number
  try {
    owner = (await (options.stat ?? stat)(directory)).uid
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new ConfigError('无法检查数据目录所属用户，请检查目录权限')
  }
  if (owner !== 0)
    throw new ConfigError(
      `数据目录属于 uid ${owner}：用运行服务的用户执行（sudo -u <用户>），或者设 NEXTSKIN_RUN_AS=<用户>；否则迁移会在数据目录里留下 root 的文件，服务读写不了`,
    )
}
