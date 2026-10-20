import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ConfigError } from './config.ts'
import type { LauncherContext } from './context.ts'

/** start 和 doctor 使用相同的发行完整性检查，避免混用不同版本的程序文件。 */
export async function assertRelease(context: LauncherContext): Promise<void> {
  if (context.source) return
  const recovery = '请停掉服务、删掉 server/ 和 cli/、重新解压完整的发行包'
  let version: string
  try {
    version = (await readFile(join(context.root, 'server/VERSION'), 'utf8')).trim()
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === 'ENOENT' ? '缺少版本标记' : '无法读取版本标记'
    throw new ConfigError(`程序版本 ${context.version}，server/ ${reason}；${recovery}`)
  }
  if (version !== context.version)
    throw new ConfigError(`程序版本 ${context.version}，server/ 版本 ${version || '为空'}，版本不一致；${recovery}`)
  try {
    await access(join(context.root, 'server/apps/web/server.js'))
  } catch {
    throw new ConfigError(
      `程序版本 ${context.version}，server/ 版本 ${version}，缺少 server/apps/web/server.js；${recovery}`,
    )
  }
}
