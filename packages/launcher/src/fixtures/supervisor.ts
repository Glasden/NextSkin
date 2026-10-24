import { fileURLToPath } from 'node:url'
import { parseLogRecord } from '@nextskin/logging'
import { createLauncherOutput } from '../output.ts'
import { supervise } from '../supervisor.ts'

// Windows 上 child.kill 发什么信号都是直接结束进程：测试改由 IPC 让这里在进程内触发同名信号
const relay = (message: { signal?: NodeJS.Signals }) => {
  if (message.signal) process.emit(message.signal, message.signal)
}
process.on('message', relay)
// 写终端的每一条记录转给测试；核心的原始输出只在 LAUNCHER_TEST_FORWARD_RAW=1 时转（大量输出的用例只看文件）
const output = createLauncherOutput(process.env, (line) => {
  const record = parseLogRecord(line)
  if (record?.raw && process.env.LAUNCHER_TEST_FORWARD_RAW !== '1') return
  process.send?.({ log: record?.msg ?? line, record, time: Date.now() })
})
if (process.env.LAUNCHER_TEST_DATA_DIR) output.openFile(process.env.LAUNCHER_TEST_DATA_DIR)
process.exitCode = await supervise({
  serverJs: fileURLToPath(new URL('./core.mjs', import.meta.url)),
  env: process.env,
  initialDelay: 20,
  maxDelay: 80,
  stableTime: 150,
  shutdownTimeout: 100,
  output,
})
await output.close()
process.off('message', relay)
