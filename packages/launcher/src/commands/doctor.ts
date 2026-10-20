/** 只检查环境，不打开核心、不生成配置、不创建数据目录或执行迁移（ADR-0039）。 */
import { constants } from 'node:fs'
import { access, mkdtemp, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { coreMigrations, createDatabase, type DatabaseConfig } from '@nextskin/db'
import { HostStartError, hostNetworkRestricted, pluginHostEntry, probePluginHost } from '@nextskin/domain'
import { coreConfigFromEnv, type CoreConfig } from '@nextskin/domain/config'
import { envFilePath, listenAddress, mergeEnv, readEnvFile } from '../config.ts'
import type { LauncherContext } from '../context.ts'
import { acquireDataLock } from '../lock.ts'

export interface CheckResult {
  item: string
  /** skip：前面的配置有错，这一项没法检查；那个错误已经单独算作失败 */
  status: 'pass' | 'warning' | 'fail' | 'skip'
  message: string
  /** 远程驱动超时后可能还握着连接；输出完毕后由命令退出进程。 */
  timedOut?: boolean
}

function result(item: string, status: CheckResult['status'], message: string): CheckResult {
  return { item, status, message }
}

export function checkNode(): CheckResult {
  return result(
    'Node',
    hostNetworkRestricted ? 'pass' : 'warning',
    `${process.versions.node}；${hostNetworkRestricted ? '插件不能直接连网' : '这个版本的权限模型拦不住插件直接连网，建议 Node 26'}`,
  )
}

export async function checkEnvFile(context: LauncherContext, env: NodeJS.ProcessEnv) {
  const file = envFilePath(context, env)
  const results: CheckResult[] = []
  try {
    const { exists, values } = await readEnvFile(file)
    const pendingSecret = !exists && !context.source && !env.NEXTSKIN_SECRET
    results.push(
      result(
        '配置文件',
        pendingSecret ? 'warning' : 'pass',
        `${file}；${exists ? '存在' : pendingSecret ? '还没有 .env，第一次 start 时生成' : '没有 .env，使用环境变量或源码模式的默认配置'}`,
      ),
    )
    if (exists && process.platform !== 'win32' && ((await stat(file)).mode & 0o044) !== 0)
      results.push(result('配置文件权限', 'warning', `同组或其他人可读，建议 chmod 600 ${file}`))
    return { results, env: mergeEnv({ ...env }, values), pendingSecret, readable: true }
  } catch {
    results.push(result('配置文件', 'fail', `读不了配置文件 ${file}；请检查文件和权限`))
    return { results, env: { ...env }, pendingSecret: false, readable: false }
  }
}

export function checkSecret(
  context: LauncherContext,
  env: NodeJS.ProcessEnv,
  originalEnv: NodeJS.ProcessEnv,
  pendingSecret: boolean,
): CheckResult {
  const secret = env.NEXTSKIN_SECRET
  const source = originalEnv.NEXTSKIN_SECRET !== undefined ? '环境变量' : '.env'
  if (secret)
    return result(
      '密钥',
      secret.length < 32 ? 'fail' : 'pass',
      `来源：${source}；${secret.length < 32 ? 'NEXTSKIN_SECRET 至少要有 32 个字符' : '长度符合要求'}`,
    )
  if (!context.source || env.NODE_ENV === 'production')
    return result(
      '密钥',
      pendingSecret ? 'warning' : 'fail',
      pendingSecret
        ? '还没有密钥，第一次 start 时生成'
        : '生产环境缺少 NEXTSKIN_SECRET，请设置至少 32 个字符的随机字符串',
    )
  return result('密钥', 'pass', '来源：源码模式的开发密钥')
}

export function checkConfig(
  context: LauncherContext,
  env: NodeJS.ProcessEnv,
): { result: CheckResult; config?: CoreConfig; host?: string; port?: number } {
  try {
    // 缺密钥单独报告；占位值仅用于解析路径和数据库，不会写回环境变量。
    const config = coreConfigFromEnv(
      { ...env, NEXTSKIN_SECRET: env.NEXTSKIN_SECRET || 'doctor-placeholder-secret-32-characters' },
      { cwd: context.root, production: !context.source || env.NODE_ENV === 'production' },
    )
    const { host, port } = listenAddress(env)
    return { result: result('其余配置', 'pass', '路径、数据库配置和监听配置已解析'), config, host, port }
  } catch (error) {
    // coreConfigFromEnv 和 listenAddress 的诊断固定、不带变量的原值。
    return { result: result('其余配置', 'fail', error instanceof Error ? error.message : '配置解析失败') }
  }
}

export async function checkDataDirectory(directory: string): Promise<CheckResult> {
  try {
    let exists = true
    try {
      await stat(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      exists = false
    }
    if (!exists) {
      let parent = dirname(directory)
      for (;;) {
        try {
          await stat(parent)
          break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === dirname(parent)) throw error
          parent = dirname(parent)
        }
      }
      await access(parent, constants.W_OK)
      return result('数据目录', 'pass', `${directory}；还不存在，start 时创建`)
    }
    let probe: string | undefined
    try {
      probe = await mkdtemp(join(directory, '.doctor-'))
      await writeFile(join(probe, 'probe'), '')
    } finally {
      if (probe) await rm(probe, { recursive: true, force: true })
    }
    const space = await statfs(directory)
    const gb = (space.bavail * space.bsize) / 1_000_000_000
    return result(
      '数据目录',
      gb < 1 ? 'warning' : 'pass',
      `${directory}；可写，剩余 ${gb.toFixed(1)} GB${gb < 1 ? '，少于 1 GB' : ''}`,
    )
  } catch {
    return result('数据目录', 'fail', `${directory}；无法写入或检查剩余空间，请检查目录权限`)
  }
}

function migrationStatus(names: string[]): { status: CheckResult['status']; message: string } {
  const known = Object.keys(coreMigrations)
  const unknown = names.filter((name) => !Object.hasOwn(coreMigrations, name)).sort()
  if (unknown.length)
    return {
      status: 'fail',
      message: `有 ${unknown.length} 个程序不认识的迁移，最大的是 ${unknown.at(-1)}；库比程序新，这个版本打不开它，请换回更新的版本`,
    }
  const executed = new Set(names)
  const pending = known.filter((name) => !executed.has(name)).length
  return pending
    ? { status: 'warning', message: `有 ${pending} 个迁移没执行，start 或 migrate 时执行` }
    : { status: 'pass', message: `全部 ${known.length} 个迁移已执行` }
}

export async function checkDatabase(config: DatabaseConfig, timeoutMs = 10_000): Promise<CheckResult> {
  let location: string = config.dialect
  let timer: NodeJS.Timeout | undefined
  try {
    if (config.dialect === 'sqlite') {
      location = `SQLite ${config.file}`
      try {
        await stat(config.file)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        return result('数据库', 'pass', `${location}；还没有数据库文件，第一次 start 时创建`)
      }
      const db = new DatabaseSync(config.file, { readOnly: true })
      try {
        const table = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'nextskin_migration'")
          .get()
        if (!table) return result('数据库', 'pass', `${location}；空库，还没执行过迁移`)
        const rows = db.prepare('SELECT name FROM nextskin_migration').all() as { name: string }[]
        const migration = migrationStatus(rows.map((row) => row.name))
        return result('数据库', migration.status, `${location}；${migration.message}`)
      } finally {
        db.close()
      }
    }
    const url = new URL(config.url)
    location = `${config.dialect === 'mysql' ? 'MySQL' : 'PostgreSQL'} ${url.hostname}:${url.port || (config.dialect === 'mysql' ? '3306' : '5432')} / ${url.pathname.slice(1)}`
    const inspect = async (): Promise<CheckResult> => {
      const db = createDatabase<{ nextskin_migration: { name: string } }>(config)
      try {
        const tables = await db.introspection.getTables()
        if (!tables.some((table) => table.name === 'nextskin_migration'))
          return result('数据库', 'pass', `${location}；空库，还没执行过迁移`)
        const rows = await db.selectFrom('nextskin_migration').select('name').execute()
        const migration = migrationStatus(rows.map((row) => row.name))
        return result('数据库', migration.status, `${location}；${migration.message}`)
      } finally {
        await db.destroy()
      }
    }
    const inspection = inspect()
    // 超时以后它还可能失败：先接住，免得成了没人处理的拒绝、在输出之前让进程崩掉
    inspection.catch(() => undefined)
    return await Promise.race([
      inspection,
      new Promise<CheckResult>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              ...result('数据库', 'fail', `${location}；检查超时，请检查连接和数据库是否可用`),
              timedOut: true,
            }),
          timeoutMs,
        )
      }),
    ])
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    // 只允许驱动的错误代码，不回显 message（它可能含用户名、密码和连接串）。
    const detail = typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? `（${code}）` : ''
    return result('数据库', 'fail', `${location}；检查失败${detail}，请检查连接、权限和数据库是否可用`)
  } finally {
    clearTimeout(timer)
  }
}

export async function checkPluginHost(
  context: LauncherContext,
  probe: typeof probePluginHost = probePluginHost,
): Promise<CheckResult> {
  try {
    const entry = pluginHostEntry({
      root: context.source ? resolve(context.root, '../..') : join(context.root, 'server'),
      bundled: !context.source,
    })
    if (!context.source) {
      try {
        await access(entry.script)
        await access(join(context.root, 'server/apps/web/server.js'))
      } catch {
        return result('plugin host', 'fail', '发行目录不完整；请重新构建或解压完整发行包')
      }
    }
    await probe(entry)
    return result('plugin host', 'pass', '已带 --permission 启动并完成握手、退出')
  } catch (error) {
    return result(
      'plugin host',
      'fail',
      error instanceof HostStartError ? error.message : '无法启动 plugin host；请检查入口、依赖和 Node 权限模型',
    )
  }
}

export async function checkService(directory: string, host: string, port: number): Promise<CheckResult> {
  let address: string | undefined
  try {
    try {
      await stat(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return result('服务', 'pass', '没有在运行')
    }
    const lock = await acquireDataLock(directory)
    if (lock) {
      lock.release()
      return result('服务', 'pass', '没有服务在用这个数据目录')
    }
    let local = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host
    if (local.includes(':') && !local.startsWith('[')) local = `[${local}]`
    address = `http://${local}:${port}/api/health`
    const response = await fetch(address, { signal: AbortSignal.timeout(5000), redirect: 'error' })
    await response.body?.cancel()
    return result(
      '服务',
      response.ok ? 'pass' : 'fail',
      response.ok ? `服务在运行，${address} 响应正常` : `服务在运行，但 ${address} 没有响应`,
    )
  } catch {
    return result(
      '服务',
      'fail',
      address ? `服务在运行，但 ${address} 没有响应` : '无法检查数据目录的锁；请检查目录权限',
    )
  }
}

export async function run(
  argv: string[],
  context: LauncherContext,
  options: { env?: NodeJS.ProcessEnv; probeHost?: typeof probePluginHost } = {},
): Promise<number> {
  if (argv.length) {
    console.log('用法：nextskin doctor')
    return argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h') ? 0 : 1
  }
  const env = options.env ?? process.env
  console.log(`NextSkin ${context.version} 环境自检，根目录 ${context.root}`)
  const skipped = (item: string) => result(item, 'skip', '配置有错，没有检查')
  const results = [checkNode()]
  const file = await checkEnvFile(context, env)
  results.push(...file.results, checkSecret(context, file.env, env, file.pendingSecret))
  const parsed = file.readable ? checkConfig(context, file.env) : { result: skipped('其余配置') }
  results.push(parsed.result)
  if (parsed.config) {
    results.push(await checkDataDirectory(parsed.config.dataDirectory), await checkDatabase(parsed.config.database))
  } else {
    results.push(skipped('数据目录'), skipped('数据库'))
  }
  results.push(await checkPluginHost(context, options.probeHost))
  results.push(
    parsed.config && parsed.host !== undefined && parsed.port !== undefined
      ? await checkService(parsed.config.dataDirectory, parsed.host, parsed.port)
      : skipped('服务'),
  )
  const labels = { pass: '通过', warning: '警告', fail: '失败', skip: '跳过' }
  for (const row of results) console.log(`[${labels[row.status]}] ${row.item}：${row.message}`)
  const warnings = results.filter((row) => row.status === 'warning').length
  const failures = results.filter((row) => row.status === 'fail').length
  console.log(warnings || failures ? `${warnings} 项警告，${failures} 项失败` : '全部通过')
  const code = failures ? 1 : 0
  if (results.some((row) => row.timedOut)) {
    // Promise.race 不能中止驱动握手；等输出刷完后显式退出，不让超时连接的句柄挂住 doctor。
    await new Promise<void>((resolve) => process.stdout.write('', () => resolve()))
    process.exit(code)
  }
  return code
}
