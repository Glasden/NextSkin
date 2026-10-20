/** 依赖打进 cli，standalone 和静态文件一起组装，发行机器不需要安装依赖（ADR-0039）。 */
import { execFile } from 'node:child_process'
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { rolldown } from 'rolldown'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const packageRoot = join(root, 'packages/launcher')
const cli = join(packageRoot, 'dist/cli')
const release = join(root, 'dist/nextskin')
const workers = ['plugin-read-worker', 'image-worker']
const replacements = new Map(workers.map((name) => [name, 0]))
await rm(cli, { recursive: true, force: true })
const bundle = await rolldown({
  input: {
    main: join(packageRoot, 'src/main.ts'),
    'plugin-read-worker': join(root, 'packages/db/src/sqlite/plugin-read-worker.ts'),
    'image-worker': join(root, 'packages/domain/src/textures/image-worker.ts'),
  },
  platform: 'node',
  cwd: packageRoot,
  external: (id) => isBuiltin(id) || id === 'pg-native',
  plugins: [
    {
      name: 'worker-urls',
      transform(code, id) {
        // Windows 上模块 id 是反斜杠路径
        const path = id.replaceAll('\\', '/')
        if (!path.endsWith('/plugin-reader.ts') && !path.endsWith('/image-pool.ts')) return
        let transformed = code
        for (const name of workers) {
          const before = `new URL('./${name}.ts', import.meta.url)`
          const count = transformed.split(before).length - 1
          replacements.set(name, replacements.get(name)! + count)
          transformed = transformed.replaceAll(before, `new URL('./${name}.mjs', import.meta.url)`)
        }
        return { code: transformed, map: null }
      },
    },
  ],
  onwarn(warning, warn) {
    if (warning.code === 'UNRESOLVED_IMPORT') throw new Error(`启动器的依赖无法解析：${warning.message}`)
    warn(warning)
  },
})
try {
  const result = await bundle.write({
    dir: cli,
    format: 'esm',
    entryFileNames: '[name].mjs',
    chunkFileNames: '[name]-[hash].mjs',
    minify: false,
  })
  // 防止拆 chunk 后把领域层合进启动路径；常驻监管进程只允许配置解析这个轻量入口。
  const chunks = result.output.filter((item) => item.type === 'chunk')
  const pending = chunks.filter(
    (chunk) =>
      (chunk.isEntry && chunk.name === 'main') ||
      Object.keys(chunk.modules).some((id) => id.replaceAll('\\', '/').endsWith('/launcher/src/commands/start.ts')),
  )
  const checked = new Set<string>()
  while (pending.length) {
    const chunk = pending.pop()!
    if (checked.has(chunk.fileName)) continue
    checked.add(chunk.fileName)
    for (const id of Object.keys(chunk.modules)) {
      const path = id.replaceAll('\\', '/')
      if (
        path.includes('/packages/db/src/') ||
        (path.includes('/packages/domain/src/') && !path.endsWith('/domain/src/config.ts'))
      )
        throw new Error('start 的静态依赖带入了数据库驱动或领域层')
    }
    for (const dependency of chunk.imports) {
      const imported = chunks.find((item) => item.fileName === dependency)
      if (imported) pending.push(imported)
    }
  }
} finally {
  await bundle.close()
}
for (const [name, count] of replacements)
  if (count !== 1) throw new Error(`${name} 的 URL 应替换一次，实际 ${count} 次`)
const references = new Set<string>()
for (const file of await readdir(cli)) {
  if (!file.endsWith('.mjs')) continue
  const code = await readFile(join(cli, file), 'utf8')
  for (const match of code.matchAll(/new URL\(["']\.\/([^"']+\.mjs)["'],\s*import\.meta\.url\)/g)) {
    const target = join(cli, match[1]!)
    if (!(await lstat(target)).isFile()) throw new Error(`worker 产物不存在：${basename(target)}`)
    references.add(match[1]!)
  }
}
for (const name of workers) if (!references.has(`${name}.mjs`)) throw new Error(`产物里缺少 ${name} 的 worker URL`)

await rm(release, { recursive: true, force: true })
await mkdir(release, { recursive: true })
const web = join(root, 'apps/web')
// standalone 里有两样构建机上的东西，next.config.ts 排除不了，只能在这里跳过：
// - 开发数据目录 apps/web/data（SQLite 库和材质）：instrumentation 和 proxy 经 lib/server.ts 把按工作目录解析的
//   数据目录追踪了进去，outputFileTracingExcludes 只作用于路由的追踪；
// - apps/web/.env、.env.production：Next 构建时读到就原样复制进 standalone。
const standalone = join(web, '.next/standalone')
const skipped = new Set([join(standalone, 'apps/web/data')])
// Windows 上 standalone 里 pnpm 和 Next 建的链接是 junction（只存绝对路径，指回构建目录），普通符号链接又要管理员权限：
// 先跳过，复制完再在发行目录里重建成指向对应位置的 junction。这样的发行目录不能挪走，只供本机 e2e；发行包在 CI 的 Linux 上构建
const links: string[] = []
await cp(standalone, join(release, 'server'), {
  recursive: true,
  verbatimSymlinks: true,
  filter: async (source) => {
    if (skipped.has(source) || basename(source).startsWith('.env')) return false
    if (process.platform !== 'win32' || !(await lstat(source)).isSymbolicLink()) return true
    links.push(source)
    return false
  },
})
for (const link of links) {
  const target = relative(standalone, resolve(dirname(link), await readlink(link)))
  if (target.startsWith('..') || isAbsolute(target)) throw new Error(`standalone 里的链接指到了外面：${link}`)
  const destination = join(release, 'server', relative(standalone, link))
  if ((await stat(link)).isDirectory()) await symlink(join(release, 'server', target), destination, 'junction')
  else await cp(link, destination)
}
await cp(join(web, '.next/static'), join(release, 'server/apps/web/.next/static'), { recursive: true })
try {
  await lstat(join(web, 'public'))
  await cp(join(web, 'public'), join(release, 'server/apps/web/public'), { recursive: true })
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
}
await cp(cli, join(release, 'cli'), { recursive: true })
for (const file of ['nextskin.mjs', 'package.json', '.env.example'])
  await cp(join(packageRoot, 'release', file), join(release, file))

for (const file of [
  'server/apps/web/server.js',
  'server/packages/plugin-host/dist/host.mjs',
  'nextskin.mjs',
  'cli/main.mjs',
])
  if (!(await lstat(join(release, file))).isFile()) throw new Error(`发行目录缺少 ${file}`)
// 不跟随 pnpm 符号链接；真实文件都在发行目录的 .pnpm 里，重复遍历还可能形成环。
async function checkDirectory(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.name.startsWith('.env') && path !== join(release, '.env.example'))
      throw new Error(`发行目录带入了构建机配置：${relative(release, path)}`)
    if (path === join(release, 'server/apps/web/data')) throw new Error('发行目录带入了开发数据目录')
    if (entry.isDirectory()) await checkDirectory(path)
  }
}
await checkDirectory(release)
const run = promisify(execFile)
await run(process.execPath, [join(release, 'nextskin.mjs'), 'version'])
const smoke = await mkdtemp(join(tmpdir(), 'nextskin-release-'))
try {
  // 避开构建环境的数据库和 .env，只对全新的临时 SQLite 数据目录做冒烟。
  await run(process.execPath, [join(release, 'nextskin.mjs'), 'migrate'], {
    cwd: dirname(smoke),
    env: {
      ...process.env,
      NEXTSKIN_ENV_FILE: join(smoke, 'absent.env'),
      NEXTSKIN_DATA_DIR: smoke,
      NEXTSKIN_DATABASE_URL: `sqlite:${join(smoke, 'nextskin.sqlite')}`,
      NEXTSKIN_SECRET: 'nextskin-build-smoke-secret-32-characters',
    },
  })
} catch {
  throw new Error('发行目录的 migrate 冒烟失败；临时 SQLite 数据目录已清理')
} finally {
  await rm(smoke, { recursive: true, force: true })
}
console.log('发行目录产物检查、version 和 SQLite migrate 冒烟通过')
console.log(`已生成 ${release}`)
