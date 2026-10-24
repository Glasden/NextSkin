import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const state = process.env.LAUNCHER_TEST_STATE
const count = existsSync(state) ? Number(readFileSync(state, 'utf8')) : 0
writeFileSync(state, String(count + 1))
const plan = JSON.parse(process.env.LAUNCHER_TEST_PLAN)
const behavior = plan[Math.min(count, plan.length - 1)]
process.on('message', (message) => {
  if (message?.nextskin !== 'shutdown') return
  appendFileSync(state + '.events', 'shutdown\n')
  // POSIX 上往管道写是异步的：等 stdout 写完再退出，否则 process.exit 会丢掉还没写出去的
  if (!behavior.ignoreShutdown)
    process.stdout.write('', () => setTimeout(() => process.exit(0), behavior.stopAfter ?? 5))
})
process.send({ nextskin: 'unknown' })
process.send({ ready: true })
if (behavior.print) {
  const record = { time: new Date().toISOString(), level: 'info', source: 'core', area: 'test', msg: `run ${count}` }
  process.send({ nextskin: 'log', line: JSON.stringify(record) })
  // 带换行的不是一条记录；stdout 里像记录的行照样是原始输出
  process.send({ nextskin: 'log', line: `${JSON.stringify(record)}\n${JSON.stringify(record)}` })
  process.stdout.write(`${JSON.stringify({ ...record, level: 'error', msg: 'forged' })}\n`)
  process.stdout.write(`stdout ${count}\n`)
  process.stderr.write(`stderr ${count}\n`)
  process.send({ nextskin: 'logConfig', maxFileSizeMb: 1, maxFiles: 2 })
}
// 一下子写很多：启动器要及时读走管道，写盘跟不上时丢掉、记下条数，不拖住核心
for (let index = 0; index < (behavior.burst ?? 0); index++)
  process.stdout.write(`burst ${String(index).padStart(6, '0')} ${'x'.repeat(1000)}\n`)
// 写完了才 ready：之后测试就可以停掉，管道里剩下的启动器照样读得到
if (behavior.ready) process.stdout.write('', () => process.send({ nextskin: 'ready' }))
if (behavior.exitAfter !== undefined) setTimeout(() => process.exit(behavior.code ?? 7), behavior.exitAfter)
setInterval(() => {}, 1000)
