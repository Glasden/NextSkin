// 命令行：从 BS v6 导入（ADR-0031）。启动器落地之前用根目录的 `pnpm import:bs -- <参数>`，之后是 `nextskin import blessing-skin`。
// 读和 `pnpm dev` 相同的环境变量（packages/domain/src/bootstrap.ts），工作目录是 apps/web。运行时服务要停着。
// 退出码：0 成功；1 有停止类问题，目标库没有改动；2 参数错误、连不上数据库或运行失败
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { coreMigrations, createDatabase, migrateToLatest, type CoreDatabase } from '@nextskin/db'
import { coreConfigFromEnv, createImagePool, createLocalTextureStorage } from '@nextskin/domain/importer'
import type { ImportProgress } from './context.ts'
import { ImportOptionsError, runImport } from './engine.ts'
import { describeIssue, reportToMarkdown } from './markdown.ts'
import { parseSourceDsn, type SourceConnection } from './source/connection.ts'
import { parseDotenv, readBsEnvironment, type BsEnvironment } from './source/env.ts'
import { failInterruptedRuns } from './target.ts'

const USAGE = `用法：pnpm import:bs -- [参数]

  --from <地址>            旧库：mysql://用户:密码@主机:端口/库名、postgres://…，或 sqlite:<文件>。
                           省略时从 --bs-env 的 DB_* 读取（推荐：命令行参数在进程列表里看得见）
  --bs-env <文件>          旧站的 .env，从里面读 PWD_METHOD、SALT、DB_PREFIX、TEXTURES_DIR 和数据库连接
  --prefix <前缀>          旧库的表前缀，覆盖 .env 的 DB_PREFIX
  --textures <目录>        旧站的材质目录，覆盖 .env 里的值
  --timezone <时区>        旧站 config/app.php 的时区，默认 Asia/Shanghai；同时写进站点设置
  --site-url <地址>        覆盖导入的站点地址
  --uuid-overrides <文件>  逐个指定角色的 UUID，JSON：{ "<pid>": "<uuid>" }
  --dry-run                完整跑一遍、生成报告，最后回滚，不复制文件
  --replace                目标库有上一次导入的数据时，重新导入要加
  --force                  上一次导入之后新站产生了数据、或者有数据却从没导入过时，仍然继续（还要 --replace）
  --report <文件>          报告的位置，默认是数据目录下的 import-<时间>.md

盐不能从命令行传：只从 --bs-env 读，或者从环境变量 BS_SALT 读。
没有 --bs-env 时，密码算法按 BS 的默认 BCRYPT。`

class UsageError extends Error {}

const KNOWN_OPTIONS = new Set([
  '--from',
  '--bs-env',
  '--prefix',
  '--textures',
  '--timezone',
  '--site-url',
  '--uuid-overrides',
  '--dry-run',
  '--replace',
  '--force',
  '--report',
  '--help',
  '-h',
  '--',
])

function fail(message: string): never {
  throw new UsageError(message)
}

async function main(argv: string[]): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: argv[0] === '--' ? argv.slice(1) : argv,
      options: {
        from: { type: 'string' },
        'bs-env': { type: 'string' },
        prefix: { type: 'string' },
        textures: { type: 'string' },
        timezone: { type: 'string' },
        'site-url': { type: 'string' },
        'uuid-overrides': { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        replace: { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
        report: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
      allowPositionals: false,
    })
  } catch (error) {
    // parseArgs 的消息会带上参数的原值（例如漏写了 --from 的连接地址），不能输出（不变量 11）。只给参数名
    const code = error instanceof Error && 'code' in error ? error.code : null
    if (code === 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL') fail('有多余的值：参数要写成 --名字 <值>，例如 --from <地址>')
    if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      const name = argv.find((arg) => /^--?[A-Za-z]/.test(arg) && !KNOWN_OPTIONS.has(arg.split('=')[0]!))
      const shown = name && /^--?[A-Za-z][A-Za-z-]*$/.test(name.split('=')[0]!) ? `：${name.split('=')[0]}` : ''
      fail(`不认识的参数${shown}`)
    }
    fail('参数不对：缺少参数的值，或者开关参数带了值')
  }
  const args = parsed.values
  if (args.help) {
    console.log(USAGE)
    return 0
  }
  const cwd = process.cwd()

  let env: BsEnvironment | null = null
  if (args['bs-env']) {
    const file = resolve(cwd, args['bs-env'])
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      fail(`读不了 --bs-env 指定的文件 ${file}`)
    }
    env = readBsEnvironment(parseDotenv(text), dirname(file))
  }
  let source: SourceConnection
  if (args.from) source = parseSourceDsn(args.from, cwd)
  else if (env?.connection) source = env.connection
  else fail('缺少旧库：用 --from 指定，或者用 --bs-env 提供写着 DB_CONNECTION、DB_DATABASE 等的 .env')

  let texturesDirectory: string
  if (args.textures) texturesDirectory = resolve(cwd, args.textures)
  else if (env?.localTextures && env.texturesDirectory) texturesDirectory = env.texturesDirectory
  else if (env) fail('旧站的材质不在本地磁盘上（FS_DRIVER 不是 local）；请先同步到本地目录，再用 --textures 指定')
  else fail('缺少旧站的材质目录：用 --textures 指定，或者用 --bs-env 提供旧站的 .env')

  let uuidOverrides: Record<string, string> = {}
  if (args['uuid-overrides']) {
    const file = resolve(cwd, args['uuid-overrides'])
    let value: unknown
    try {
      value = JSON.parse(await readFile(file, 'utf8'))
    } catch {
      fail(`--uuid-overrides 的文件 ${file} 读不了，或者不是 JSON`)
    }
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.values(value).some((item) => typeof item !== 'string')
    )
      fail('--uuid-overrides 的文件要是 JSON 对象：键是 pid，值是 UUID 字符串')
    uuidOverrides = value as Record<string, string>
  }

  const config = coreConfigFromEnv(process.env, { cwd, production: process.env.NODE_ENV === 'production' })
  if (config.database.dialect === 'sqlite') await mkdir(dirname(config.database.file), { recursive: true })
  const db = createDatabase<CoreDatabase>(config.database)
  const imagePool = createImagePool()
  const controller = new AbortController()
  const interrupt = () => {
    if (controller.signal.aborted) process.exit(2)
    console.error('\n正在取消：目标库的事务会回滚。再按一次 Ctrl+C 立即退出')
    controller.abort()
  }
  process.on('SIGINT', interrupt)
  try {
    try {
      await migrateToLatest(db, coreMigrations)
    } catch {
      // 不回显原始错误：里面可能有连接串（不变量 11）
      fail('连接 NextSkin 的数据库或执行迁移失败；请检查 NEXTSKIN_DATABASE_URL 和数据库是否可用')
    }
    const interrupted = await failInterruptedRuns(db, new Date())
    if (interrupted) console.error(`上次有 ${interrupted} 次运行中途退出，已标为失败`)

    let lastPrint = 0
    let lastStage = ''
    const onProgress = (progress: ImportProgress) => {
      const time = Date.now()
      if (progress.stage === lastStage && time - lastPrint < 1000) return
      lastPrint = time
      lastStage = progress.stage
      console.error(`[${progress.stage}] ${progress.rows} 行，${progress.files} 个文件`)
    }
    // 每个角色的 UUID 和来源写进与报告同名的 .uuids.csv：报告里只放得下统计和一部分
    const uuidLines = ['pid,name,uuid,source']
    const csv = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value)
    const result = await runImport({
      db,
      source,
      prefix: args.prefix ?? env?.prefix ?? '',
      texturesDirectory,
      timeZone: args.timezone ?? 'Asia/Shanghai',
      passwordMethod: env?.passwordMethod ?? null,
      salt: process.env.BS_SALT ?? env?.salt ?? '',
      siteUrl: args['site-url'] ?? null,
      uuidOverrides,
      dryRun: args['dry-run'],
      replace: args.replace,
      force: args.force,
      entry: 'cli',
      storage: createLocalTextureStorage(config.textureDirectory),
      imagePool,
      secretKey: config.secretKey,
      signal: controller.signal,
      onProgress,
      onPlayerUuid: (entry) => uuidLines.push([entry.pid, csv(entry.name), entry.uuid, entry.source].join(',')),
    })
    const stamp = result.report.startedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
    const reportFile = args.report ? resolve(cwd, args.report) : join(config.dataDirectory, `import-${stamp}.md`)
    await mkdir(dirname(reportFile), { recursive: true })
    await writeFile(reportFile, reportToMarkdown(result.report))
    const uuidFile = reportFile.replace(/(\.md)?$/, '.uuids.csv')
    await writeFile(uuidFile, uuidLines.join('\n') + '\n')
    const { report } = result
    if (result.status === 'succeeded')
      console.log(
        report.dryRun
          ? '试跑完成，没有停止类问题。结果已经回滚，真正导入时去掉 --dry-run。'
          : `导入完成：用户 ${report.tables.users.imported}、角色 ${report.tables.players.imported}、材质 ${report.tables.textures.imported}。用旧站的账号登录。`,
      )
    else if (result.status === 'blocked') {
      console.log(`有 ${report.blocking.total} 个停止类问题，目标库没有改动：`)
      for (const issue of report.blocking.items.slice(0, 10)) console.log(`- ${describeIssue(issue)}`)
      if (report.blocking.total > 10) console.log(`……其余见报告`)
    } else
      console.log(
        result.status === 'cancelled' ? '已取消，目标库没有改动。' : `导入失败，目标库没有改动：${report.error}`,
      )
    console.log(`报告：${reportFile}（运行记录 #${result.runId}）`)
    console.log(`每个角色的 UUID 和来源：${uuidFile}（同一个 pid 出现两次时以后一行为准）`)
    return result.status === 'succeeded' ? 0 : result.status === 'blocked' ? 1 : 2
  } finally {
    process.off('SIGINT', interrupt)
    await imagePool.close()
    await db.destroy()
  }
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  if (error instanceof UsageError || error instanceof ImportOptionsError) {
    console.error(`${error.message}\n\n${USAGE}`)
  } else {
    // 旧库的连接错误已经由 packages/db 脱敏；其余错误只给类型和消息
    console.error(`导入失败：${error instanceof Error ? error.message : String(error)}`)
  }
  process.exitCode = 2
}
