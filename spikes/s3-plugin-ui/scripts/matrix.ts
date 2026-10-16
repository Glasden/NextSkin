/**
 * 依次在各模式下启动宿主并跑 tests/s3.spec.ts。
 * 运行：node scripts/matrix.ts [dev] [dev-webpack] [turbopack] [webpack]   （不带参数时跑全部）
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const PORT = 3300
const all = ['dev', 'dev-webpack', 'turbopack', 'webpack'] as const
type Mode = (typeof all)[number]
const modes = (process.argv.length > 2 ? process.argv.slice(2) : all) as Mode[]

const run = (cmd: string, args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } })
  return r.status ?? 1
}

async function waitReady(url: string, ms: number) {
  const started = Date.now()
  while (Date.now() - started < ms) {
    try {
      if ((await fetch(url)).ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`${url} 在 ${ms} ms 内没有就绪`)
}

function stop(child: ChildProcess) {
  return new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve()
    child.once('exit', () => resolve())
    // next 会再拉起子进程，按进程组结束
    process.kill(-child.pid!, 'SIGTERM')
  })
}

if (run('node', ['scripts/gen-shims.ts']) !== 0 || run('node', ['scripts/build-plugins.ts']) !== 0) process.exit(1)
const xorigin = spawn('node', ['scripts/xorigin-server.ts'], { cwd: root, stdio: 'ignore', detached: true })

const results: Record<string, number> = {}
for (const mode of modes) {
  console.log(`\n===== ${mode}`)
  const webpack = mode === 'webpack' || mode === 'dev-webpack' ? ['--webpack'] : []
  if (!mode.startsWith('dev') && run('npx', ['next', 'build', ...webpack]) !== 0) {
    results[mode] = 1
    continue
  }
  const args = mode.startsWith('dev') ? ['next', 'dev', ...webpack, '--port', String(PORT)] : ['next', 'start', '--port', String(PORT)]
  const server = spawn('npx', args, { cwd: root, stdio: 'ignore', detached: true })
  try {
    await waitReady(`http://localhost:${PORT}/`, 120_000)
    results[mode] = run('npx', ['playwright', 'test'], { S3_MODE: mode })
  } finally {
    await stop(server)
  }
}
process.kill(-xorigin.pid!, 'SIGTERM')

console.log('\n===== 汇总')
for (const [mode, status] of Object.entries(results)) console.log(`${mode}: ${status === 0 ? '通过' : '失败'}`)
process.exit(Object.values(results).every((s) => s === 0) ? 0 : 1)
