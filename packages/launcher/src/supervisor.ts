import { spawn, type ChildProcess } from 'node:child_process'
import { dirname } from 'node:path'

export interface SupervisorOptions {
  serverJs: string
  env: NodeJS.ProcessEnv
  /** 测试用毫秒级时长，生产环境沿用 ADR-0039 的上限。 */
  initialDelay?: number
  maxDelay?: number
  stableTime?: number
  shutdownTimeout?: number
  log?: (message: string) => void
}

/** 只监管核心，host 的退出由核心关闭 stdin 保证。 */
export function supervise(options: SupervisorOptions): Promise<number> {
  const initialDelay = options.initialDelay ?? 1000
  const maxDelay = options.maxDelay ?? 60_000
  const stableTime = options.stableTime ?? 300_000
  const shutdownTimeout = options.shutdownTimeout ?? 30_000
  const log = (message: string) => (options.log ?? console.error)(`[nextskin] ${message}`)
  return new Promise((resolve) => {
    let child: ChildProcess | undefined
    let stopping = false
    let finished = false
    let delay = initialDelay
    let readyAt: number | undefined
    let restart: NodeJS.Timeout | undefined
    let deadline: NodeJS.Timeout | undefined
    const signals: NodeJS.Signals[] =
      process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGHUP'] : ['SIGINT', 'SIGTERM']
    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(restart)
      clearTimeout(deadline)
      for (const signal of signals) process.off(signal, stop)
      resolve(0)
    }
    const force = () => {
      if (child) child.kill('SIGKILL')
      else finish()
    }
    const stop = (signal: NodeJS.Signals) => {
      if (stopping) {
        if (signal === 'SIGINT') force()
        return
      }
      stopping = true
      clearTimeout(restart)
      if (!child) return finish()
      log('正在停止核心')
      if (child.connected) {
        try {
          child.send({ nextskin: 'shutdown' }, () => {
            /* 通道可能正随着核心退出而关闭。 */
          })
        } catch {
          /* 通道已经关闭时，仍然等退出或超时。 */
        }
      }
      deadline = setTimeout(force, shutdownTimeout)
    }
    const launch = () => {
      readyAt = undefined
      const current = spawn(process.execPath, [options.serverJs], {
        cwd: dirname(options.serverJs),
        env: options.env,
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      })
      child = current
      current.on('message', (message: unknown) => {
        if (
          stopping ||
          readyAt !== undefined ||
          !message ||
          typeof message !== 'object' ||
          !('nextskin' in message) ||
          message.nextskin !== 'ready'
        )
          return
        readyAt = Date.now()
        log('核心已启动')
      })
      // spawn 失败也会发 close；统一在 close 重启，避免一次失败排两个定时器。
      current.on('error', () => log('无法启动核心进程'))
      current.once('close', (code, signal) => {
        child = undefined
        if (stopping) return finish()
        if (readyAt !== undefined && Date.now() - readyAt >= stableTime) delay = initialDelay
        log(`核心退出（${signal ? `信号 ${signal}` : `退出码 ${code ?? '未知'}`}），${delay} 毫秒后重启`)
        restart = setTimeout(launch, delay)
        delay = Math.min(delay * 2, maxDelay)
      })
    }
    for (const signal of signals) process.on(signal, stop)
    launch()
  })
}
