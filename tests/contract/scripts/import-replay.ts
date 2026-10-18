// 录制环境上的端到端检查（ADR-0031）：把 BS 录制环境的固定数据导入一个新的 SQLite 库，再用它回放契约用例。
//   pnpm --filter @nextskin/contract-tests import-replay
// 和录制一样需要 Docker：先按 bs-v6/README.md 启动录制环境。脚本会像录制脚本一样重写 BS 里的固定数据。
// 旧站真实的表结构、密码哈希和 UUID 分配都经过一次"导入后协议行为不变"的检验。
import { copyFile, cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createApp } from '@nextskin/api'
import { coreMigrations, createDatabase, migrateToLatest, type CoreDatabase } from '@nextskin/db'
import { createCore, createImagePool, createLocalTextureStorage } from '@nextskin/domain'
import { parseDotenv, readBsEnvironment, reportToMarkdown, runImport } from '@nextskin/importer'
import { cases, DEFAULT_HEADERS, scenarios } from '../src/cases.ts'
import { recordBody, recordHeaders } from '../src/recording.ts'
import { checkCase, checkScenario, loadRecording, sendHttp, type Send } from '../src/replay.ts'
import { ORIGIN } from '../src/world.ts'
import { assertSigningPublicKey } from '../src/yggdrasil.ts'
import { app, BS_DATABASE, clearCache, compose, copyTextures, openBsDatabase, seedDatabase } from './bs-instance.ts'

/**
 * 已知差异：固定数据里 `stored: false` 的材质（world.ts）模拟"导入之后存储里丢了文件"，契约回放的种子照样写了它的
 * texture_files 行。真实导入时它在旧站本来就缺文件，按导入规则跳过，引用它的角色材质置空（docs/schema.md），
 * 所以这几个用例与录制结果不同，不比较
 */
const KNOWN_DIFFERENCES = new Set(['csl/ghost', 'ygg/profile-ghost'])

const secretKey = 'nextskin-import-replay-secret-0123456789'
const directory = await mkdtemp(join(tmpdir(), 'nextskin-import-replay-'))
try {
  // 1. 旧站：写入录制用的固定数据（与录制脚本相同），把材质目录和 .env 取出来
  const bs = await openBsDatabase()
  try {
    await seedDatabase(bs, 'insert')
  } finally {
    await bs.end()
  }
  copyTextures()
  clearCache()
  const bsTextures = join(directory, 'bs-textures')
  execFileSync('docker', ['compose', '-f', compose, 'cp', 'app:/app/storage/textures/.', bsTextures], { stdio: 'pipe' })
  const environment = readBsEnvironment(parseDotenv(app('cat', '.env')), '/app')
  const meta = await sendHttp(new URL(ORIGIN))({
    method: 'GET',
    path: '/api/yggdrasil',
    headers: DEFAULT_HEADERS,
    body: '',
  })
  if (meta.body.kind !== 'json') throw new Error('BS 的 /api/yggdrasil 没有返回 JSON')
  // 导入的签名私钥就是 BS 的那把，NextSkin 签名后用 BS 的公钥验证
  const publicKey = assertSigningPublicKey((meta.body.value as { signaturePublickey?: unknown }).signaturePublickey)

  // 2. 导入一个新的 SQLite 库，作为每个世界的模板
  const template = join(directory, 'template.sqlite')
  const textures = join(directory, 'textures')
  const db = createDatabase<CoreDatabase>({ dialect: 'sqlite', file: template })
  const imagePool = createImagePool()
  try {
    await migrateToLatest(db, coreMigrations)
    const result = await runImport({
      db,
      source: {
        dialect: 'mysql',
        host: BS_DATABASE.host,
        port: BS_DATABASE.port,
        database: BS_DATABASE.database,
        username: BS_DATABASE.user,
        password: BS_DATABASE.password,
      },
      prefix: environment.prefix,
      texturesDirectory: bsTextures,
      // BS 的 config/app.php 写死了 Asia/Shanghai
      timeZone: 'Asia/Shanghai',
      passwordMethod: environment.passwordMethod,
      salt: environment.salt,
      dryRun: false,
      replace: false,
      force: false,
      entry: 'cli',
      storage: createLocalTextureStorage(textures),
      imagePool,
      secretKey,
    })
    if (result.status !== 'succeeded') {
      console.error(reportToMarkdown(result.report))
      throw new Error(`导入没有成功：${result.status}`)
    }
    console.log(
      `导入完成：用户 ${result.report.tables.users.imported}、角色 ${result.report.tables.players.imported}、材质 ${result.report.tables.textures.imported}，` +
        `比对 ${result.report.verification.checked} 个角色`,
    )
  } finally {
    await imagePool.close()
    await db.destroy()
  }

  // 3. 回放：一问一答的用例共用一个世界，场景各用一份模板的副本
  let worlds = 0
  async function createWorld(): Promise<{ send: Send; close(): Promise<void> }> {
    const id = worlds++
    const file = join(directory, `world-${id}.sqlite`)
    const storage = join(directory, `world-${id}-textures`)
    await copyFile(template, file)
    await cp(textures, storage, { recursive: true })
    const database = createDatabase<CoreDatabase>({ dialect: 'sqlite', file })
    const core = createCore({
      db: database,
      textureStorage: createLocalTextureStorage(storage),
      secretKey,
      production: false,
    })
    const hono = createApp({ core })
    return {
      send: async (request) => {
        const host = request.headers.host ?? DEFAULT_HEADERS.host!
        const response = await hono.request(`http://${host}${request.path}`, {
          method: request.method,
          headers: request.headers,
          body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
        })
        return {
          status: response.status,
          headers: recordHeaders(response.headers.entries()),
          body: recordBody(
            response.headers.get('content-type') ?? undefined,
            new Uint8Array(await response.arrayBuffer()),
          ),
        }
      },
      async close() {
        await core.shutdown()
        await database.destroy()
      },
    }
  }

  const recording = loadRecording()
  const startedAt = Date.now()
  const context = { recording, publicKey, startedAt }
  const failures: string[] = []
  const known: string[] = []
  const world = await createWorld()
  try {
    for (const contractCase of cases) {
      const problems = await checkCase(world.send, contractCase, context)
      if (KNOWN_DIFFERENCES.has(contractCase.id))
        known.push(`${contractCase.id}${problems.length ? '' : '（这次一致）'}`)
      else if (problems.length) failures.push(`${contractCase.id}\n  ${problems.join('\n  ')}`)
    }
  } finally {
    await world.close()
  }
  for (const scenario of scenarios) {
    const fresh = await createWorld()
    try {
      const problems = await checkScenario(fresh.send, scenario, context)
      if (problems.length) failures.push(`${scenario.id}\n  ${problems.join('\n  ')}`)
    } finally {
      await fresh.close()
    }
  }
  console.log(
    `回放 ${cases.length} 个用例、${scenarios.length} 个场景；已知差异 ${known.length} 个：${known.join('、')}`,
  )
  if (failures.length) {
    console.error(`\n${failures.length} 处与 BS v6 不一致：\n${failures.join('\n')}`)
    process.exitCode = 1
  } else console.log('导入后协议行为与 BS v6 一致')
} finally {
  await rm(directory, { recursive: true, force: true })
}
