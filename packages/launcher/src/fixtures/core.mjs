import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const state = process.env.LAUNCHER_TEST_STATE
const count = existsSync(state) ? Number(readFileSync(state, 'utf8')) : 0
writeFileSync(state, String(count + 1))
const plan = JSON.parse(process.env.LAUNCHER_TEST_PLAN)
const behavior = plan[Math.min(count, plan.length - 1)]
process.on('message', (message) => {
  if (message?.nextskin !== 'shutdown') return
  appendFileSync(state + '.events', 'shutdown\n')
  if (!behavior.ignoreShutdown) setTimeout(() => process.exit(0), behavior.stopAfter ?? 5)
})
process.send({ nextskin: 'unknown' })
process.send({ ready: true })
if (behavior.ready) process.send({ nextskin: 'ready' })
if (behavior.exitAfter !== undefined) setTimeout(() => process.exit(behavior.code ?? 7), behavior.exitAfter)
setInterval(() => {}, 1000)
