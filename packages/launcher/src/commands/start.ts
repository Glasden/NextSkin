import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ConfigError, readConfig } from '../config.ts'
import type { LauncherContext } from '../context.ts'
import { acquireDataLock } from '../lock.ts'
import { supervise } from '../supervisor.ts'

export async function run(_argv: string[], context: LauncherContext): Promise<number> {
  if (context.source)
    throw new ConfigError('start 只能在发行目录里运行：先运行 pnpm build，再运行 node dist/nextskin/nextskin.mjs start')
  if (Number(process.versions.node.split('.')[0]) < 26)
    console.error('[nextskin] Node 24、25 的 plugin host 拦不住插件直接连网，建议使用 Node 26。')
  const { config, env, host, port } = await readConfig(context)
  const serverJs = join(context.root, 'server/apps/web/server.js')
  let probe: string | undefined
  try {
    await mkdir(config.dataDirectory, { recursive: true })
    probe = await mkdtemp(join(config.dataDirectory, '.write-check-'))
    await writeFile(join(probe, 'probe'), '')
  } catch {
    throw new ConfigError(`数据目录 ${config.dataDirectory} 无法创建或写入；请检查目录权限`)
  } finally {
    if (probe) await rm(probe, { recursive: true, force: true })
  }
  try {
    await access(serverJs)
  } catch {
    throw new ConfigError('发行目录缺少 server/apps/web/server.js；请重新构建或解压完整发行包')
  }
  let lock
  try {
    lock = await acquireDataLock(config.dataDirectory)
  } catch {
    throw new ConfigError(`无法锁定数据目录 ${config.dataDirectory}；请检查目录权限`)
  }
  if (!lock)
    throw new ConfigError(`数据目录 ${config.dataDirectory} 已经有服务在用：同一个数据目录同时只能运行一个 start`)
  console.error(
    `[nextskin] NextSkin ${context.version}，Node ${process.versions.node}，数据目录 ${config.dataDirectory}，数据库 ${config.database.dialect}，监听 ${host}:${port}`,
  )
  try {
    return await supervise({ serverJs, env })
  } finally {
    lock.release()
  }
}
