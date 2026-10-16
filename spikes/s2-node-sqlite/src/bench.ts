/**
 * 并发基准：对每个"模式 × 干扰"组合启动一个服务进程（绑在 CPU 0-2），本进程用 autocannon 施压（应绑在 CPU 3）。
 *
 *   taskset -c 3 node src/bench.ts [--modes A,B,C,D,E] [--interfere none,slow,tx] [--duration 15] [--node /path/to/node]
 *
 * 请求组合（每个连接循环发送）：CSL 3、hasJoined 3、衣柜 2、join 1、点赞 1，即 20% 写。
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { parseArgs } from 'node:util'
import autocannon from 'autocannon'
import { SIZES, freshCopy } from './schema.ts'

const { values: args } = parseArgs({
  options: {
    modes: { type: 'string', default: 'A,B,C,D,E' },
    interfere: { type: 'string', default: 'none,slow,tx' },
    duration: { type: 'string', default: '15' },
    connections: { type: 'string', default: '32' },
    node: { type: 'string', default: process.execPath },
  },
})
const PORT = 3100
const rnd = (n: number) => 1 + Math.floor(Math.random() * n)

async function startServer(mode: string, interfere: string): Promise<ChildProcess> {
  const file = freshCopy(`bench-${mode}`)
  const child = spawn('taskset', ['-c', '0-2', args.node!, 'src/server.ts'], {
    env: { ...process.env, MODE: mode, DB_FILE: file, INTERFERE: interfere, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (b: Buffer) => b.toString().includes('ready') && resolve())
    child.on('exit', (code) => reject(new Error(`服务进程提前退出 ${code}`)))
  })
  return child
}

function load(duration: number) {
  const json = { 'content-type': 'application/json' }
  const requests: autocannon.Request[] = [
    ...Array.from({ length: 3 }, () => ({ setupRequest: (r: any) => ({ ...r, method: 'GET', path: `/csl/p${rnd(SIZES.players)}` }) })),
    ...Array.from({ length: 3 }, () => ({
      setupRequest: (r: any) => {
        const pid = rnd(SIZES.sessions)
        return { ...r, method: 'GET', path: `/ygg/hasJoined?username=p${pid}&serverId=s${pid}` }
      },
    })),
    ...Array.from({ length: 2 }, () => ({ setupRequest: (r: any) => ({ ...r, method: 'GET', path: `/closet/${rnd(SIZES.users)}?page=1` }) })),
    { setupRequest: (r: any) => ({ ...r, method: 'POST', path: '/ygg/join', headers: json, body: JSON.stringify({ serverId: `j${Math.random()}`, pid: rnd(SIZES.players) }) }) },
    { setupRequest: (r: any) => ({ ...r, method: 'POST', path: `/like/${rnd(SIZES.textures)}`, headers: json, body: JSON.stringify({ uid: rnd(SIZES.users) }) }) },
  ]
  return autocannon({ url: `http://127.0.0.1:${PORT}`, connections: Number(args.connections), duration, requests })
}

const rows: string[] = []
for (const interfere of args.interfere!.split(',')) {
  for (const mode of args.modes!.split(',')) {
    const child = await startServer(mode, interfere)
    try {
      await load(3) // 预热
      await fetch(`http://127.0.0.1:${PORT}/stats/reset`, { method: 'POST' })
      const r = await load(Number(args.duration))
      const stats = (await (await fetch(`http://127.0.0.1:${PORT}/stats`)).json()) as any
      const extra =
        interfere === 'slow'
          ? `慢查询 ${stats.slowDone} 次，平均 ${(stats.slowMsTotal / Math.max(1, stats.slowDone)).toFixed(0)} ms`
          : interfere === 'tx'
            ? `插件事务 ${stats.txDone} 次，失败 ${stats.txErrors}`
            : ''
      const line = `| ${mode} | ${interfere} | ${Math.round(r.requests.average)} | ${r.latency.p50} | ${r.latency.p99} | ${r.latency.max} | ${stats.eventLoopDelayMs.p99.toFixed(1)} | ${stats.eventLoopDelayMs.max.toFixed(0)} | ${r.non2xx + r.errors + r.timeouts} | ${extra} |`
      console.log(line)
      rows.push(line)
    } finally {
      child.kill('SIGTERM')
      await once(child, 'exit')
    }
  }
}

console.log(`\nNode ${args.node === process.execPath ? process.version : args.node}，${args.connections} 并发，每轮 ${args.duration} 秒`)
console.log('| 模式 | 干扰 | req/s | p50 ms | p99 ms | max ms | 事件循环延迟 p99 ms | 事件循环延迟 max ms | 失败 | 备注 |')
console.log('|---|---|---|---|---|---|---|---|---|---|')
for (const l of rows) console.log(l)
