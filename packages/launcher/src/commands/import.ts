import { checkImportArgs, runImportCli } from '@nextskin/importer/cli'
import type { ReadCommandContext } from '../context.ts'
import { acquireDataLock } from '../lock.ts'

export async function run(argv: string[], read: ReadCommandContext): Promise<number> {
  const early = checkImportArgs(argv)
  if (early !== null) return early
  const context = await read()
  let lock
  try {
    lock = await acquireDataLock(context.config.dataDirectory)
  } catch {
    console.error('[nextskin] 无法锁定数据目录；请检查目录权限。')
    return 2
  }
  if (!lock) {
    console.error(`[nextskin] 数据目录 ${context.config.dataDirectory} 上的服务正在运行；导入前先停掉服务`)
    return 2
  }
  try {
    return await runImportCli(argv, { config: context.config, cwd: context.cwd })
  } finally {
    lock.release()
  }
}
