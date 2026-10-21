import { fileURLToPath } from 'node:url'
import metadata from '../package.json' with { type: 'json' }
import { ConfigError, readConfig } from './config.ts'
import type { LauncherContext } from './context.ts'

async function main(): Promise<number> {
  if (Number(process.versions.node.split('.')[0]) < 24)
    throw new ConfigError(`需要 Node 24 或更新版本，推荐 Node 26；当前版本 ${process.versions.node}`)
  const source = import.meta.url.endsWith('.ts')
  const root = fileURLToPath(new URL(source ? '../../../apps/web/' : '../', import.meta.url))
  const { version } = metadata
  const context: LauncherContext = {
    root,
    // 源码里 pnpm 在仓库根目录运行脚本，INIT_CWD 才是敲命令的目录；发行目录里它只可能是从外层 npm 脚本继承来的
    cwd: (source && process.env.INIT_CWD) || process.cwd(),
    source,
    production: !source || process.env.NODE_ENV === 'production',
    version,
  }
  const argv = process.argv.slice(2)
  if (argv[0] === '--') argv.shift()
  const command = argv.shift()
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return (await import('./commands/help.ts')).run(argv, context)
  }
  if (command === 'version') {
    return (await import('./commands/version.ts')).run(argv, context)
  }
  if (command === 'doctor') return (await import('./commands/doctor.ts')).run(argv, context)
  if (command === 'start') return (await import('./commands/start.ts')).run(argv, context)
  if (command === 'import' && argv.shift() !== 'blessing-skin') {
    console.error('用法：nextskin import blessing-skin [参数]')
    return 1
  }
  // 每个入口单独 import，start 的模块图里不出现领域层或数据库驱动。
  const read = () => readConfig(context)
  switch (command) {
    case 'migrate':
      return (await import('./commands/migrate.ts')).run(argv, read)
    case 'set-role':
      return (await import('./commands/set-role.ts')).run(argv, read)
    case 'set-password':
      return (await import('./commands/set-password.ts')).run(argv, read)
    case 'disable-2fa':
      return (await import('./commands/disable-2fa.ts')).run(argv, read)
    case 'disable-captcha':
      return (await import('./commands/disable-captcha.ts')).run(argv, read)
    case 'maintenance':
      return (await import('./commands/maintenance.ts')).run(argv, read)
    case 'plugin':
      return (await import('./commands/plugin.ts')).run(argv, read)
    case 'import':
      return (await import('./commands/import.ts')).run(argv, read)
    default:
      ;(await import('./commands/help.ts')).run(argv, context)
      return 1
  }
}

try {
  process.exitCode = await main()
} catch (error) {
  console.error(
    `[nextskin] ${error instanceof ConfigError ? error.message : '命令执行失败；请检查配置、文件权限和数据库是否可用。'}`,
  )
  process.exitCode = error instanceof ConfigError ? 78 : 1
}
