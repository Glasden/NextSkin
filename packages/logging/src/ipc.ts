import { isLogFileLimits, type LogFileLimits } from './file.ts'

/**
 * 由启动器拉起时，核心经 IPC 发给启动器的消息（ADR-0062）：一条记录，和日志文件的轮换上限。
 * 结构化记录不走 stdout：混在原始输出里就只能靠"像不像 JSON"来区分，原始输出也就能伪造成核心的记录
 */
export interface LogMessage {
  nextskin: 'log'
  line: string
}

export interface LogConfigMessage extends LogFileLimits {
  nextskin: 'logConfig'
}

/** 启动器那一侧：是一条记录就返回这一行，不是返回 null */
export function logLineFromMessage(message: unknown): string | null {
  if (typeof message !== 'object' || message === null) return null
  const { nextskin, line } = message as Record<string, unknown>
  // 一条记录一行：带换行的会在文件里断成两行
  if (nextskin !== 'log' || typeof line !== 'string' || /[\r\n]/.test(line)) return null
  return line
}

/** 启动器那一侧：是轮换上限、取值也在范围里就返回，不是返回 null */
export function logLimitsFromMessage(message: unknown): LogFileLimits | null {
  if (typeof message !== 'object' || message === null) return null
  const { nextskin, maxFileSizeMb, maxFiles } = message as Record<string, unknown>
  const limits = { maxFileSizeMb, maxFiles }
  return nextskin === 'logConfig' && isLogFileLimits(limits) ? limits : null
}

/** `process`：核心和启动器之间的 IPC 通道 */
export interface IpcChannel {
  readonly connected: boolean
  send?(message: unknown, callback: (error: Error | null) => void): boolean
}

/**
 * 核心那一侧的出口：记录经 IPC 发给启动器。积压在通道里、还没发出去的超过 `maxBacklog` 条时丢掉新的、记下条数，
 * 下一次发出去时先补一条 warn 说丢了几条。通道断开、发送失败的改写 `fallback`（stderr）
 */
export function ipcLogWriter(
  channel: IpcChannel,
  fallback: (line: string) => void,
  maxBacklog = 1000,
): (line: string) => void {
  let backlog = 0
  let dropped = 0
  const send = (line: string) => {
    backlog++
    try {
      channel.send!({ nextskin: 'log', line } satisfies LogMessage, (error) => {
        backlog--
        // 发出去之前通道关了（启动器正在退出）
        if (error) fallback(line)
      })
    } catch {
      backlog--
      fallback(line)
    }
  }
  const notice = () => {
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level: 'warn',
      source: 'core',
      area: 'logging',
      msg: 'log_ipc_dropped',
      dropped,
    })
    dropped = 0
    return line
  }
  return (line) => {
    if (!channel.connected || !channel.send) {
      if (dropped > 0) fallback(notice())
      return fallback(line)
    }
    if (backlog >= maxBacklog) {
      dropped++
      return
    }
    if (dropped > 0) send(notice())
    send(line)
  }
}
