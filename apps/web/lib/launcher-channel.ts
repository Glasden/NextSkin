// 由启动器拉起时，和它之间的控制通道（ADR-0039）：打开核心之后发 ready；收到 shutdown 或者通道断开（启动器被强制结束）时，
// 先停定时任务和执行器、等执行中的任务结束，再照 Next 收到 SIGTERM 的流程关掉 HTTP 服务、退出。
// 只传这两种消息；Next 自己在私有的环境变量下也用 IPC，不认识的消息一律不管
import type { Server } from './server'

const holder = globalThis as typeof globalThis & { nextskinLauncherConnected?: boolean }

/**
 * `opening` 是启动时打开核心的那一次；`current` 取现在缓存的那一次（打开失败后由请求重新打开的，也要在停止时收掉任务）。
 * 不是启动器拉起的（`next dev`、直接运行 server.js）就什么都不做
 */
export function connectLauncher(opening: Promise<Server>, current: () => Promise<Server> | undefined): void {
  if (process.env.NEXTSKIN_LAUNCHER_IPC !== '1' || !process.send || holder.nextskinLauncherConnected) return
  holder.nextskinLauncherConnected = true

  // 打开失败也算就绪：HTTP 照常服务，请求时重试（ADR-0039"崩溃重启"），启动器只拿它决定什么时候清零退避
  const ready = () => {
    if (process.connected) process.send?.({ nextskin: 'ready' })
  }
  opening.then(ready, ready)

  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    // 启动器在时，它 30 秒后强杀；通道断开时启动器已经不在了，自己兜底：核心卡在打开里（数据库不回握手）、
    // 在途请求不结束时照样退出，不留下锁外运行的核心
    setTimeout(() => process.exit(1), 35_000).unref()
    const server = await current()?.catch(() => null)
    if (server) {
      // jobs.stop 最多等 10 秒，到时 abort 执行中的任务，剩下的等租约到期后由下次启动接手（ADR-0021）
      await server.core.schedules.stop().catch(() => undefined)
      await server.core.jobs.stop().catch(() => undefined)
    }
    // Next 的处理函数关掉 HTTP 服务、等在途请求结束后自己退出。在进程内触发它：Windows 没有信号可发
    if (process.listenerCount('SIGTERM') > 0) process.emit('SIGTERM', 'SIGTERM')
    else process.exit(0)
  }
  process.on('message', (message: unknown) => {
    if (typeof message === 'object' && message !== null && (message as { nextskin?: unknown }).nextskin === 'shutdown')
      void shutdown()
  })
  process.on('disconnect', () => void shutdown())
  // 注册之前启动器就可能已经退出（Next 先监听端口、后执行 instrumentation），那时的 disconnect 没有人收到
  if (!process.connected) void shutdown()
}
