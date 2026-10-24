import { parseArgs } from 'node:util'
import { openCore, MigrationBackupError, OfficialPluginMigrationError, type MigrationReport } from '@nextskin/domain'
import { officialPlugins } from '@nextskin/official-plugins'
import type { ReadCommandContext } from '../context.ts'

const USAGE = '用法：nextskin migrate [--json]'

export async function run(argv: string[], read: ReadCommandContext): Promise<number> {
  let json: boolean
  try {
    const { values } = parseArgs({
      args: argv,
      options: { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
      strict: true,
      allowPositionals: false,
    })
    if (values.help) {
      console.log(USAGE)
      return 0
    }
    json = values.json ?? false
  } catch {
    console.error(USAGE)
    return 1
  }
  const { log, info } = console
  if (json) console.log = console.info = (...args) => console.error(...args)
  try {
    // 配置错误交给 main 映射为 78，不当作迁移失败。
    const context = await read()
    const migrationReport: MigrationReport = { core: [], plugins: [], backup: null }
    try {
      const opened = await openCore(context.config, {
        startJobs: false,
        migrationReport,
        officialPlugins,
      })
      const { migrations } = opened
      // 迁移已经提交：关闭时出错不能报成迁移失败，否则升级流程会把成功的升级回滚掉
      await opened.close().catch(() => {})
      if (json) log(JSON.stringify(migrations))
      else {
        for (const name of migrations.core) log(`[nextskin] 已执行迁移 ${name}`)
        for (const item of migrations.plugins)
          for (const name of item.migrations) log(`[nextskin] 已执行插件 ${item.plugin} 的迁移 ${name}`)
        if (migrations.backup) log(`[nextskin] 迁移之前已备份数据库到 ${migrations.backup}`)
        if (!migrations.core.length && !migrations.plugins.length) log('[nextskin] 没有要执行的迁移')
      }
      return 0
    } catch (error) {
      const kind = error instanceof MigrationBackupError ? 'backup' : 'migration'
      const message =
        error instanceof MigrationBackupError || error instanceof OfficialPluginMigrationError
          ? error.message
          : '执行迁移失败；请检查数据库配置、连接和权限。'
      if (json) log(JSON.stringify({ error: { kind, message }, ...migrationReport }))
      else console.error(`[nextskin] ${message}`)
      return 1
    }
  } finally {
    console.log = log
    console.info = info
  }
}
