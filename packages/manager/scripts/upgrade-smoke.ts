import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'

let output = ''
let databaseUrl: string | undefined
let secret = ''
let active: ReturnType<typeof start> | undefined

function capture(chunk: string) {
  output = (output + chunk).split('\n').slice(-201).join('\n')
}

// 只使用本次生成的 .env；调用方的部署环境不能把测试引向别的实例或数据库。
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NEXTSKIN_')))

function start(home: string) {
  const child = spawn(process.execPath, ['nextskin.mjs', 'start'], {
    cwd: home,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8').on('data', capture)
  child.stderr.setEncoding('utf8').on('data', capture)
  const state = {
    child,
    ended: false,
    done: new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('error', () => capture('\n无法启动 Node 子进程\n'))
      child.once('close', (code, signal) => resolve({ code, signal }))
    }),
  }
  void state.done.then(() => {
    state.ended = true
  })
  return state
}

/** 健康检查返回 200 时为 true；服务先退出了为 false。 */
async function healthy(port: number, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    assert(active, '服务没有启动')
    if (active.ended) return false
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2_000) })
      await response.body?.cancel()
      if (response.status === 200) return true
    } catch {
      // 迁移和启动期间暂时连不上，下次继续探测。
    }
    await sleep(500)
  }
  throw new Error(`健康检查在 ${timeout / 1_000} 秒内未返回 200`)
}

async function readPointer(home: string) {
  const file = join(home, 'releases/current.json')
  if (!existsSync(file)) return null
  return JSON.parse(await readFile(file, 'utf8')) as { current: string; bundled: string; previous: string | null }
}

async function stop() {
  assert(active && !active.ended, '服务在 SIGTERM 前已经退出')
  const current = active
  current.child.kill('SIGTERM')
  let timer: NodeJS.Timeout | undefined
  try {
    const result = await Promise.race([
      current.done,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('SIGTERM 后 45 秒仍未退出')), 45_000)
      }),
    ])
    assert.equal(result.signal, null, '服务应自行退出，不能由信号终止')
    assert.equal(result.code, 0, '服务收到 SIGTERM 后应以 0 退出')
    active = undefined
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      work: { type: 'string' },
      'database-url': { type: 'string' },
      port: { type: 'string' },
    },
  })
  databaseUrl = values['database-url']
  assert(
    values.from && values.to && values.work && values.port,
    '用法：node upgrade-smoke.ts --from <旧 ZIP> --to <新 ZIP> --work <空目录> [--database-url <url>] --port <端口>',
  )
  const port = Number(values.port)
  assert(/^\d+$/.test(values.port) && Number.isInteger(port) && port >= 1 && port <= 65535, '端口必须是 1–65535 的整数')
  const work = resolve(values.work)
  const from = resolve(values.from)
  const to = resolve(values.to)
  await mkdir(work, { recursive: true })
  assert.equal((await readdir(work)).length, 0, '工作目录必须为空')

  const unpack = (archive: string) => execFileSync('unzip', ['-oq', archive, '-d', work], { stdio: 'pipe' })
  unpack(from)
  const home = join(work, 'nextskin')
  const legacy = existsSync(join(home, 'server')) && existsSync(join(home, 'cli'))
  const oldVersion = (await readFile(join(home, legacy ? 'server/VERSION' : 'manager/VERSION'), 'utf8')).trim()
  secret = randomBytes(32).toString('hex')
  // JSON 引号兼容 dotenv，也避免连接串中的 # 或空格被截断；文件和连接串都不打印。
  await writeFile(
    join(home, '.env'),
    [
      `NEXTSKIN_SECRET=${secret}`,
      'NEXTSKIN_HOST=127.0.0.1',
      `NEXTSKIN_PORT=${port}`,
      ...(databaseUrl ? [`NEXTSKIN_DATABASE_URL=${JSON.stringify(databaseUrl)}`] : []),
      '',
    ].join('\n'),
    { mode: 0o600 },
  )
  console.log(`[upgrade-smoke] 旧版本 ${oldVersion}（${legacy ? '旧布局' : '版本目录'}）`)
  active = start(home)
  assert(await healthy(port, 180_000), '旧版本在健康检查通过前退出')
  console.log('[upgrade-smoke] 旧版本 /api/health 200')
  await stop()
  console.log('[upgrade-smoke] 旧版本 SIGTERM → 0')

  unpack(to)
  const version = (await readFile(join(home, 'manager/VERSION'), 'utf8')).trim()
  console.log(`[upgrade-smoke] 覆盖解压新版本 ${version}`)
  active = start(home)
  let switched = await healthy(port, 300_000)
  if (databaseUrl) {
    // 外部数据库有迁移时，启动不替管理员确认备份（ADR-0061"手动解压"）：旧布局以 78 退出，版本目录照旧运行旧版本。
    // 照部署文档的做法，停着服务运行 update --backup-confirmed，再启动。
    const pointer = await readPointer(home)
    if (!switched || pointer?.current !== version) {
      if (switched) await stop()
      else {
        assert.equal((await active.done).code, 78, '新版本在健康检查通过前退出')
        active = undefined
      }
      console.log('[upgrade-smoke] 外部数据库有迁移：停着服务运行 update --backup-confirmed')
      const update = spawnSync(process.execPath, ['nextskin.mjs', 'update', '--backup-confirmed', '--yes'], {
        cwd: home,
        env,
        encoding: 'utf8',
      })
      capture(`${update.stdout}${update.stderr}`)
      assert.equal(update.status, 0, 'update --backup-confirmed 失败')
      active = start(home)
      switched = await healthy(port, 300_000)
    }
  }
  assert(switched, '新版本在健康检查通过前退出')
  console.log('[upgrade-smoke] 新版本 /api/health 200')
  // 核心先返回 200，管理进程随后才记日志、删旧目录；等清理收尾，避免把正常时序误报成失败。
  const cleanupDeadline = Date.now() + 15_000
  for (;;) {
    try {
      const pointer = await readPointer(home)
      assert(pointer, '没有 releases/current.json')
      assert.equal(pointer.current, version, 'current 应为新版本')
      assert.equal(pointer.bundled, version, 'bundled 应为新版本')
      if (legacy) {
        assert(!existsSync(join(home, 'server')), '旧布局 server/ 未删除')
        assert(!existsSync(join(home, 'cli')), '旧布局 cli/ 未删除')
      } else assert.equal(pointer.previous, oldVersion, 'previous 应为旧版本')
      const lines = (await readFile(join(home, 'releases/update-log.jsonl'), 'utf8')).trim().split('\n')
      const last = JSON.parse(lines.at(-1)!) as { kind: string; result: string }
      assert.equal(last.kind, legacy ? 'legacy' : 'manual', '升级日志 kind 不匹配')
      assert.equal(last.result, 'success', '升级日志应为 success')
      const staging = join(home, 'releases/.staging')
      assert(!existsSync(staging) || (await readdir(staging)).length === 0, '.staging/ 有残留')
      console.log(`[upgrade-smoke] current = bundled = ${version}；${last.kind} success；旧目录和 staging 已清理`)
      break
    } catch (error) {
      if (Date.now() >= cleanupDeadline || active.ended) throw error
      await sleep(250)
    }
  }
  await stop()
  console.log('[upgrade-smoke] 新版本 SIGTERM → 0；冒烟通过')
}

try {
  await main()
} catch (error) {
  // 不输出错误对象的命令参数或环境；日志再遮盖本次生成的秘密，避免失败诊断泄露它们。
  let message = error instanceof Error ? error.message : '未知错误'
  for (const value of [databaseUrl, secret]) {
    if (value) {
      message = message.replaceAll(value, '[redacted]')
      output = output.replaceAll(value, '[redacted]')
    }
  }
  console.error(`[upgrade-smoke] 失败：${message}`)
  console.error(`子进程最后 200 行：\n${output.trimEnd().split('\n').slice(-200).join('\n')}`)
  process.exitCode = 1
} finally {
  if (active && !active.ended) {
    active.child.kill('SIGTERM')
    const timer = setTimeout(() => active?.child.kill('SIGKILL'), 45_000)
    await active.done
    clearTimeout(timer)
  }
}
