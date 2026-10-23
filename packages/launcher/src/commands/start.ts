import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ConfigError, currentUser, readConfig } from '../config.ts'
import type { LauncherContext } from '../context.ts'
import { acquireDataLock } from '../lock.ts'
import { assertRelease } from '../release.ts'
import { stopSignals, supervise } from '../supervisor.ts'

export async function run(_argv: string[], context: LauncherContext): Promise<number> {
  if (context.source)
    throw new ConfigError('start 只能在发行目录里运行：先运行 pnpm build，再运行 node dist/nextskin/nextskin.mjs start')
  if (Number(process.versions.node.split('.')[0]) < 26)
    console.error('[nextskin] Node 24、25 的 plugin host 拦不住插件直接连网，建议使用 Node 26。')
  // 拉起核心之前就接住停止信号，交给 supervise 时才放开：作为容器的 PID 1 时（1Panel 里用 exec 启动），
  // 没有处理函数的 SIGTERM 会被忽略，等锁的时候停不下来，锁一放开还会照样拉起核心
  const managed = process.env.NEXTSKIN_MANAGED === '1' && typeof process.send === 'function'
  const stopOn = managed ? listenForManagedStop : undefined
  const stop = listenForStop(stopOn)
  try {
    return await prepareAndSupervise(context, stop, stopOn)
  } finally {
    stop.dispose()
  }
}

async function prepareAndSupervise(
  context: LauncherContext,
  stop: StopListener,
  stopOn?: (stop: () => void) => () => void,
): Promise<number> {
  await assertRelease(context)
  const { config, env, host, port } = await readConfig(context)
  const serverJs = join(context.root, 'server/apps/web/server.js')
  let probe: string | undefined
  try {
    await mkdir(config.dataDirectory, { recursive: true })
    probe = await mkdtemp(join(config.dataDirectory, '.write-check-'))
    await writeFile(join(probe, 'probe'), '')
  } catch {
    throw new ConfigError(`数据目录 ${config.dataDirectory} 无法创建或写入；请检查目录权限${currentUser()}`)
  } finally {
    if (probe) await rm(probe, { recursive: true, force: true })
  }
  const lock = await lockDataDirectory(config.dataDirectory, 40_000, stop)
  if (!lock || stop.requested) {
    lock?.release()
    console.error('[nextskin] 收到停止信号，没有启动核心')
    return 0
  }
  // supervise 同步地注册自己的信号处理，和这里的 dispose 之间不会漏掉信号
  stop.dispose()
  console.error(
    `[nextskin] NextSkin ${context.version}，Node ${process.versions.node}，数据目录 ${config.dataDirectory}，数据库 ${config.database.dialect}，监听 ${host}:${port}`,
  )
  try {
    return await supervise({
      serverJs,
      env,
      stopOn,
      onReady: stopOn
        ? (pid) => {
            if (!process.connected) return
            try {
              process.send?.({ nextskin: 'ready', version: context.version, host, port, pid }, () => {
                /* 父进程可能正随着发送退出。 */
              })
            } catch {
              /* 通道已经关闭时，由 disconnect 触发停止。 */
            }
          }
        : undefined,
    })
  } finally {
    lock.release()
  }
}

// 宝塔重启项目时给整个进程树发 SIGTERM，0.5 秒后就再启动，不等退出（ADR-0040）：上一个实例还在收任务、拿着锁时等它放开。
// 上一个启动器 30 秒后强杀核心，核心自己 35 秒兜底，所以最多等 40 秒。收到停止信号时返回 null
export async function lockDataDirectory(
  directory: string,
  wait = 40_000,
  stop?: StopListener,
): Promise<{ release(): void } | null> {
  const deadline = Date.now() + wait
  for (let waiting = false; ; waiting = true) {
    let lock
    try {
      lock = await acquireDataLock(directory)
    } catch {
      throw new ConfigError(`无法锁定数据目录 ${directory}；请检查目录权限`)
    }
    if (lock) return lock
    if (stop?.requested) return null
    if (Date.now() >= deadline)
      throw new ConfigError(`数据目录 ${directory} 已经有服务在用：同一个数据目录同时只能运行一个 start`)
    if (!waiting) console.error(`[nextskin] 数据目录 ${directory} 正被另一个服务使用，等它退出，最多 ${wait / 1000} 秒`)
    await (stop ? stop.sleep(500) : new Promise((resolve) => setTimeout(resolve, 500)))
    if (stop?.requested) return null
  }
}

export interface StopListener {
  readonly requested: boolean
  /** 睡 `ms` 毫秒，收到停止信号时提前醒来。 */
  sleep(ms: number): Promise<void>
  dispose(): void
}

function listenForManagedStop(stop: () => void): () => void {
  const onMessage = (message: unknown) => {
    if (message && typeof message === 'object' && 'nextskin' in message && message.nextskin === 'shutdown') stop()
  }
  process.on('message', onMessage)
  process.on('disconnect', stop)
  process.channel?.unref()
  if (!process.connected) stop()
  return () => {
    process.off('message', onMessage)
    process.off('disconnect', stop)
  }
}

export function listenForStop(stopOn?: (stop: () => void) => () => void): StopListener {
  let requested = false
  let wake = () => {}
  const onSignal = () => {
    requested = true
    wake()
  }
  for (const signal of stopSignals) process.on(signal, onSignal)
  const disposeStop = stopOn?.(onSignal)
  return {
    get requested() {
      return requested
    },
    sleep: (ms) =>
      new Promise((resolve) => {
        if (requested) return resolve()
        const timer = setTimeout(resolve, ms)
        wake = () => {
          clearTimeout(timer)
          resolve()
        }
      }),
    dispose() {
      for (const signal of stopSignals) process.off(signal, onSignal)
      disposeStop?.()
    },
  }
}
