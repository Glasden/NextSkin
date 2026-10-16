/**
 * 失控查询能否被中断？node:sqlite 没有暴露 sqlite3_interrupt 和 progress handler。
 * 这里测三种办法，每种都在 worker 里跑一条约 3 秒的插件查询：
 *   1. 直接 worker.terminate()；
 *   2. 查询里带一个 JS 自定义函数（每行调用一次），再 worker.terminate()；
 *   3. 同上，但函数自己检查期限、超时就抛错（不需要 terminate）。
 *
 *   node src/terminate.ts <db 文件>
 */
import { DatabaseSync } from 'node:sqlite'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'

const SQL_PLAIN = 'select count(*) n from p_demo__records a join p_demo__records b on a.v < b.v where a.id <= 6000 and b.id <= 6000'
const SQL_TICK = `${SQL_PLAIN} and ns_tick()`

if (!isMainThread) {
  const { file, variant, deadlineMs } = workerData as { file: string; variant: 1 | 2 | 3; deadlineMs: number }
  const db = new DatabaseSync(file, { readOnly: true })
  const deadline = Date.now() + deadlineMs
  let calls = 0
  db.function('ns_tick', { deterministic: false, varargs: false }, () => {
    // 每 4096 次调用检查一次时间，降低开销
    if (variant === 3 && (++calls & 4095) === 0 && Date.now() > deadline) throw new Error('查询超过期限')
    return 1
  })
  const t0 = performance.now()
  try {
    const row = db.prepare(variant === 1 ? SQL_PLAIN : SQL_TICK).get()
    parentPort!.postMessage({ done: true, ms: performance.now() - t0, row })
  } catch (e: any) {
    parentPort!.postMessage({ done: false, ms: performance.now() - t0, error: e.message })
  }
} else {
  const file = process.argv[2]!
  // 基线：同样的查询直接在主线程执行要多久，以及 ns_tick() 带来的额外开销
  {
    const db = new DatabaseSync(file, { readOnly: true })
    db.function('ns_tick', { deterministic: false }, () => 1)
    for (const [name, q] of [
      ['无函数', SQL_PLAIN],
      ['带 ns_tick()', SQL_TICK],
    ] as const) {
      const t0 = performance.now()
      db.prepare(q).get()
      console.log(`基线（主线程）${name}: ${(performance.now() - t0).toFixed(0)} ms`)
    }
    db.close()
  }
  for (const variant of [1, 2, 3] as const) {
    const w = new Worker(new URL(import.meta.url), { workerData: { file, variant, deadlineMs: 300 } })
    const t0 = performance.now()
    const result = new Promise<any>((resolve) => {
      w.on('message', resolve)
      w.on('exit', () => resolve({ exited: true }))
    })
    let terminateMs = -1
    if (variant !== 3) {
      await new Promise((r) => setTimeout(r, 300))
      const t1 = performance.now()
      await w.terminate()
      terminateMs = performance.now() - t1
    }
    const r = await result
    if (variant === 3) await w.terminate()
    console.log(
      `方式 ${variant}: ` +
        (variant === 3 ? '' : `terminate() 等待 ${terminateMs.toFixed(0)} ms，`) +
        `从启动到结束 ${(performance.now() - t0).toFixed(0)} ms，worker 报告 ${JSON.stringify(r)}`,
    )
  }
}
