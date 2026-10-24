import { realpathSync } from 'node:fs'
import { managerHelp, runManagementCommand } from './cli.ts'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ConfigError, reason } from './types.ts'
import { requireVersion } from './state.ts'
import { connectControl } from './control.ts'
import { selectedVersion, start } from './start.ts'
import { managerLogger } from './log.ts'

export async function dispatch(
  home: string,
  bundled: string,
  command = (process.argv[2] === '--' ? process.argv[3] : process.argv[2]) ?? 'help',
  load?: (version: string) => Promise<void>,
): Promise<number> {
  const importLauncher =
    load ??
    (async (version: string) => {
      process.env.NEXTSKIN_HOME = home
      await import(pathToFileURL(join(home, 'releases', version, 'nextskin.mjs')).href)
    })
  const args = process.argv.slice(process.argv[2] === '--' ? 3 : 2)
  if (['update', 'rollback', 'releases'].includes(command))
    return runManagementCommand(home, bundled, [command, ...args.slice(1)])
  if (command === 'import' && (await connectControl(home))) {
    console.error('NextSkin 正在运行（管理进程），先停掉服务再导入')
    return 1
  }
  if (command === 'help') console.log(managerHelp)
  if (command === 'start') return start({ home, bundled, importLauncher })
  process.env.NEXTSKIN_HOME = home
  await importLauncher(await selectedVersion(home, bundled))
  return 0
}
async function main(): Promise<void> {
  // 打包后 main.mjs 位于 manager/；实例目录始终由根入口的位置确定，不读 .env。
  const home = dirname(dirname(fileURLToPath(import.meta.url)))
  const command = (process.argv[2] === '--' ? process.argv[3] : process.argv[2]) ?? 'help'
  try {
    let bundled: string
    try {
      bundled = (await readFile(join(home, 'manager/VERSION'), 'utf8')).trim()
    } catch {
      throw new ConfigError('发行目录不完整，缺少 manager/VERSION')
    }
    requireVersion(bundled)
    const code = await dispatch(home, bundled, command)
    // 透传的启动器可能已经设置了更准确的退出码。
    if (code !== 0 || process.exitCode === undefined) process.exitCode = code
  } catch (error) {
    if (command === 'start') managerLogger().error(reason(error))
    else console.error(`[nextskin] ${reason(error)}`)
    process.exitCode = error instanceof ConfigError ? 78 : 1
  }
}
// main 也可被测试导入；发行入口的动态 import 需要执行这里。
if (
  directlyRun() ||
  (basename(fileURLToPath(import.meta.url)) === 'main.mjs' &&
    basename(dirname(fileURLToPath(import.meta.url))) === 'manager')
)
  await main()

function directlyRun(): boolean {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return true
  }
}
