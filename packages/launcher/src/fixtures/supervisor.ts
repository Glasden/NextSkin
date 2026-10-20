import { fileURLToPath } from 'node:url'
import { supervise } from '../supervisor.ts'

// Windows 上 child.kill 发什么信号都是直接结束进程：测试改由 IPC 让这里在进程内触发同名信号
const relay = (message: { signal?: NodeJS.Signals }) => {
  if (message.signal) process.emit(message.signal, message.signal)
}
process.on('message', relay)
process.exitCode = await supervise({
  serverJs: fileURLToPath(new URL('./core.mjs', import.meta.url)),
  env: process.env,
  initialDelay: 20,
  maxDelay: 80,
  stableTime: 150,
  shutdownTimeout: 100,
  log: (message) => process.send?.({ log: message, time: Date.now() }),
})
process.off('message', relay)
