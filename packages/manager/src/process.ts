import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { ManagerError, object } from './types.ts'
import type { RunAs, RunAsOptions } from './run-as.ts'
import { interruptibleSleep } from './lock.ts'

export const stopSignals: readonly NodeJS.Signals[] =
  process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGHUP'] : ['SIGINT', 'SIGTERM']
export interface Runtime extends RunAsOptions {
  spawn?: typeof spawn
  kill?: typeof process.kill
  fetch?: typeof fetch
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  log?: (line: string) => void
  shutdownTimeout?: number
  healthTimeout?: number
  healthInterval?: number
  requestTimeout?: number
  initialDelay?: number
  maxDelay?: number
  stableTime?: number
  signal?: AbortSignal
}
export function launcherEnv(home: string, env: NodeJS.ProcessEnv = process.env, runAs?: RunAs): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env, NEXTSKIN_HOME: home }
  delete result.NEXTSKIN_MANAGER
  if (runAs) {
    // 不继承 root 的用户目录和身份，避免子进程把配置或缓存写进管理员的目录。
    delete result.HOME
    delete result.USER
    delete result.LOGNAME
  }
  // doctor 和 migrate 不是被监管的启动器，也不能继承外层的 IPC 模式。
  delete result.NEXTSKIN_MANAGER_ADDRESS
  delete result.NEXTSKIN_MANAGER_TOKEN
  delete result.NEXTSKIN_MANAGED
  return result
}
export interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
}
export function runCommand(
  home: string,
  version: string,
  command: string,
  options: Runtime & { timeout?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = (options.spawn ?? spawn)(
      process.execPath,
      [join(home, 'releases', version, 'nextskin.mjs'), command, '--json'],
      {
        cwd: home,
        env: launcherEnv(home, options.env, options.runAs),
        ...(options.runAs ? { uid: options.runAs.uid, gid: options.runAs.gid } : {}),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    let stdout = ''
    let stderr = ''
    let failed = false
    const abort = () => {
      failed = true
      child.kill('SIGKILL')
    }
    const timer = setTimeout(abort, options.timeout ?? 120_000)
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    child.stdout?.setEncoding('utf8').on('data', (data: string) => {
      stdout += data
      // 只接收小型 JSON 报告；失控的子进程不能把管理进程的内存吃完。
      if (stdout.length > 4 * 1024 * 1024) abort()
    })
    child.stderr?.setEncoding('utf8').on('data', (data: string) => {
      stderr = (stderr + data).slice(-4096)
    })
    child.on('error', () => {
      failed = true
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      if (failed) reject(new ManagerError(options.signal?.aborted ? '操作已取消' : `${command} 超时或无法运行`))
      // stderr 只保留末尾几行供诊断，不写进持久日志。
      else resolve({ code, stdout, stderr: stderr.split('\n').slice(-5).join('\n') })
    })
  })
}
export interface Ready {
  nextskin: 'ready'
  version: string
  host: string
  port: number
  pid?: number
}
interface Session {
  version: string
  child: ChildProcess
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  exit?: { code: number | null; signal: NodeJS.Signals | null }
  ready?: Ready
  readyAt?: number
  startedAt: number
  forced?: boolean
}
export function healthUrl(ready: Pick<Ready, 'host' | 'port'>): string {
  let host = ready.host === '0.0.0.0' ? '127.0.0.1' : ready.host === '::' ? '::1' : ready.host
  if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`
  return `http://${host}:${ready.port}/api/health`
}

/** 一个对象持有唯一的启动器；切换期间暂停重启，避免迁移和旧程序同时打开库。 */
export class LauncherSupervisor {
  readonly finished: Promise<number>
  private finish!: (code: number) => void
  private session?: Session
  private generation = 0
  private restart?: AbortController
  private stopping?: Promise<void>
  private closed = false
  private delay: number
  readonly home: string
  private control?: { address: string; token: string }
  setControl(control?: { address: string; token: string }): void {
    this.control = control
  }
  private readonly options: Runtime
  constructor(home: string, options: Runtime = {}) {
    this.home = home
    this.options = options
    this.delay = options.initialDelay ?? 1000
    this.finished = new Promise((resolve) => {
      this.finish = resolve
    })
  }
  private log(message: string) {
    ;(this.options.log ?? console.error)(`[nextskin] ${message}`)
  }
  private now() {
    return (this.options.now ?? Date.now)()
  }
  private launch(version: string): Session {
    const child = (this.options.spawn ?? spawn)(
      process.execPath,
      [join(this.home, 'releases', version, 'nextskin.mjs'), 'start'],
      {
        cwd: this.home,
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        env: {
          ...launcherEnv(this.home, this.options.env, this.options.runAs),
          NEXTSKIN_MANAGED: '1',
          ...(this.control
            ? { NEXTSKIN_MANAGER_ADDRESS: this.control.address, NEXTSKIN_MANAGER_TOKEN: this.control.token }
            : {}),
        },
        ...(this.options.runAs ? { uid: this.options.runAs.uid, gid: this.options.runAs.gid } : {}),
        // POSIX 的终端信号只交给管理进程，启动器的停止一律经 IPC。
        detached: process.platform !== 'win32',
        windowsHide: true,
      },
    )
    const session: Session = {
      version,
      child,
      startedAt: this.now(),
      done: new Promise((resolve) => {
        child.once('close', (code, signal) => {
          session.exit = { code, signal }
          resolve(session.exit)
        })
      }),
    }
    child.on('error', () => this.log('无法启动版本启动器'))
    child.on('message', (message: unknown) => {
      if (
        !object(message) ||
        message.nextskin !== 'ready' ||
        message.version !== version ||
        typeof message.host !== 'string' ||
        !message.host ||
        /[\s/?#@]/.test(message.host) ||
        typeof message.port !== 'number' ||
        !Number.isInteger(message.port) ||
        message.port < 1 ||
        message.port > 65535 ||
        (message.pid !== undefined &&
          (typeof message.pid !== 'number' || !Number.isSafeInteger(message.pid) || message.pid <= 0))
      )
        return
      session.ready = message as unknown as Ready
      session.readyAt = this.now()
    })
    this.session = session
    return session
  }
  async start(version: string, healthCheck = false): Promise<void> {
    if (this.closed || this.options.signal?.aborted) throw new ManagerError('管理进程正在停止')
    if (this.session && !this.session.exit) throw new ManagerError('启动器还没有停止')
    const generation = ++this.generation
    const session = this.launch(version)
    if (healthCheck) await this.healthy(session)
    this.monitor(session, version, generation)
  }
  /** 外部数据库已迁移时不换回程序，恢复新版本的日常监管。 */
  resume(version: string): void {
    if (this.closed || this.options.signal?.aborted) return
    const session = this.session
    const generation = ++this.generation
    if (session?.version === version) this.monitor(session, version, generation)
    else void this.start(version).catch(() => this.finish(1))
  }
  private monitor(session: Session, version: string, generation: number): void {
    void session.done
      .then(async ({ code, signal }) => {
        if (generation !== this.generation || this.closed) return
        if (code === 0 || code === 78) {
          this.finish(code)
          return
        }
        if (session.readyAt !== undefined && this.now() - session.readyAt >= (this.options.stableTime ?? 300_000))
          this.delay = this.options.initialDelay ?? 1000
        const delay = this.delay
        this.delay = Math.min(delay * 2, this.options.maxDelay ?? 60_000)
        this.log(`启动器退出（${signal ? `信号 ${signal}` : `退出码 ${code ?? '未知'}`}），${delay} 毫秒后重启`)
        const restart = new AbortController()
        this.restart = restart
        await (this.options.sleep ?? interruptibleSleep)(delay, restart.signal)
        if (generation !== this.generation || this.closed || this.options.signal?.aborted) return
        const next = this.launch(version)
        this.monitor(next, version, generation)
      })
      .catch(() => this.finish(1))
  }
  private async healthy(session: Session): Promise<void> {
    const deadline = session.startedAt + (this.options.healthTimeout ?? 120_000)
    while (this.now() < deadline) {
      if (this.options.signal?.aborted) throw new ManagerError('管理进程正在停止')
      if (session.exit)
        throw new ManagerError(session.exit.code === 78 ? '新版本配置错误（退出码 78）' : '启动器在健康检查之前退出')
      if (session.ready) {
        try {
          const response = await (this.options.fetch ?? fetch)(healthUrl(session.ready), {
            redirect: 'error',
            signal: AbortSignal.any([
              AbortSignal.timeout(Math.max(1, Math.min(this.options.requestTimeout ?? 5000, deadline - this.now()))),
              ...(this.options.signal ? [this.options.signal] : []),
            ]),
          })
          await response.body?.cancel()
          if (response.status === 200 && !session.exit && !this.options.signal?.aborted) return
        } catch {
          /* HTTP 服务可能还没开始监听，继续等到截止时间。 */
        }
      }
      await (this.options.sleep ?? interruptibleSleep)(
        Math.min(this.options.healthInterval ?? 250, Math.max(0, deadline - this.now())),
        this.options.signal,
      )
    }
    throw new ManagerError('新版本健康检查超时')
  }
  get hasStarted(): boolean {
    return this.session !== undefined
  }
  get running(): boolean {
    return !!this.session && !this.session.exit
  }
  force(): void {
    const session = this.session
    if (!session || session.exit) return
    session.forced = true
    session.child.kill('SIGKILL')
    const pid = session.ready?.pid
    if (!pid) {
      this.log('强杀启动器时没有核心 pid，无法确认核心是否已经退出')
      return
    }
    try {
      ;(this.options.kill ?? process.kill)(pid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') this.log('无法强杀核心，请人工检查核心是否已经退出')
    }
  }
  private async waitForCore(session: Session): Promise<void> {
    const pid = session.ready?.pid
    if (!session.forced || !pid) return
    const deadline = this.now() + 5000
    for (;;) {
      try {
        ;(this.options.kill ?? process.kill)(pid, 0)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      }
      if (this.now() >= deadline) {
        this.log('强杀后核心在 5 秒内仍未退出，请人工检查')
        return
      }
      // 启动器已经退了，核心可能还在收尾；停止信号不能跳过这段等待。
      await (this.options.sleep ?? interruptibleSleep)(Math.min(50, deadline - this.now()))
    }
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    ++this.generation
    this.restart?.abort()
    const session = this.session
    this.stopping = (async () => {
      if (!session) return
      if (session.exit) {
        await this.waitForCore(session)
        return
      }
      this.log('正在停止启动器')
      if (session.child.connected) {
        try {
          session.child.send({ nextskin: 'shutdown' }, () => {})
        } catch {
          /* IPC 已断开时，启动器自己也会停止。 */
        }
      }
      const timer = setTimeout(() => this.force(), this.options.shutdownTimeout ?? 35_000)
      try {
        await session.done
      } finally {
        clearTimeout(timer)
      }
      await this.waitForCore(session)
    })().finally(() => {
      this.stopping = undefined
    })
    return this.stopping
  }
  async shutdown(): Promise<void> {
    this.closed = true
    await this.stop()
    this.finish(0)
  }
}
