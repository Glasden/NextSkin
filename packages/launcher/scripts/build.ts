/**
 * 依赖打进 cli，standalone 和静态文件一起组装，发行机器不需要安装依赖（ADR-0039）。
 * 布局见 ADR-0061：根目录是管理进程的入口和 manager/，这个版本的启动器和程序在 releases/<版本>/
 */
import { execFile } from 'node:child_process'
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { rolldown } from 'rolldown'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const packageRoot = join(root, 'packages/launcher')
const cli = join(packageRoot, 'dist/cli')
const managerRoot = join(root, 'packages/manager')
const managerDist = join(managerRoot, 'dist')
const release = join(root, 'dist/nextskin')
const run = promisify(execFile)
const { version } = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as { version: string }
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

// 管理进程打成一个文件：它被面板或 systemd 直接监管、很少更新，只用 Node 内置模块、清单的校验和解压（ADR-0061）
await rm(managerDist, { recursive: true, force: true })
const managerBundle = await rolldown({
  input: { main: join(managerRoot, 'src/main.ts') },
  platform: 'node',
  cwd: managerRoot,
  external: (id) => isBuiltin(id),
  onwarn(warning, warn) {
    if (warning.code === 'UNRESOLVED_IMPORT') throw new Error(`管理进程的依赖无法解析：${warning.message}`)
    warn(warning)
  },
})
try {
  const result = await managerBundle.write({
    dir: managerDist,
    format: 'esm',
    entryFileNames: '[name].mjs',
    codeSplitting: false,
    minify: false,
  })
  const files = result.output.map((item) => item.fileName)
  if (files.length !== 1 || files[0] !== 'main.mjs')
    throw new Error(`管理进程应打成一个 main.mjs，实际是 ${files.join('、')}`)
  for (const id of Object.keys((result.output[0] as { modules: Record<string, unknown> }).modules)) {
    const path = id.replaceAll('\\', '/')
    if (path.includes('/packages/db/') || path.includes('/packages/domain/') || path.includes('/packages/launcher/'))
      throw new Error('管理进程带入了数据库驱动、领域层或启动器：它只管版本，不连数据库')
  }
} finally {
  await managerBundle.close()
}

await rm(release, { recursive: true, force: true })
const program = join(release, 'releases', version)
await mkdir(program, { recursive: true })
const web = join(root, 'apps/web')
// standalone 里有两样构建机上的东西，next.config.ts 排除不了，只能在这里跳过：
// - 开发数据目录 apps/web/data（SQLite 库和材质）：instrumentation 和 proxy 经 lib/server.ts 把按工作目录解析的
//   数据目录追踪了进去，outputFileTracingExcludes 只作用于路由的追踪；
// - apps/web/.env、.env.production：Next 构建时读到就原样复制进 standalone。
const standalone = join(web, '.next/standalone')
const skipped = new Set([join(standalone, 'apps/web/data')])
// 链接全部丢弃；只记录 Turbopack 外部包别名，稍后生成支持 ESM 和 CJS 的转发包。
const aliases = new Map<string, string>()
await cp(standalone, join(program, 'server'), {
  recursive: true,
  filter: async (source) => {
    if (skipped.has(source) || basename(source).startsWith('.env')) return false
    if (!(await lstat(source)).isSymbolicLink()) return true
    if (relative(standalone, dirname(source)).replaceAll('\\', '/') === 'apps/web/.next/node_modules') {
      const { name } = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as { name: string }
      aliases.set(basename(source), name)
    }
    return false
  },
})
const modules = join(program, 'server/node_modules')
const store = join(modules, '.pnpm')
// scope 目录本身不是包；只收集其中真实存在的包目录。
async function packages(directory: string): Promise<string[]> {
  const paths: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const path = join(directory, entry.name)
    if (entry.name.startsWith('@')) {
      for (const child of await readdir(path, { withFileTypes: true }))
        if (child.isDirectory()) paths.push(join(path, child.name))
    } else paths.push(path)
  }
  return paths
}
const origins = new Map<string, string>()
async function movePackage(source: string, name: string) {
  const previous = origins.get(name)
  if (previous) throw new Error(`发行依赖包名冲突：${name}；来源：${previous} 和 ${source}`)
  origins.set(name, source)
  const destination = join(modules, name)
  if (source !== destination) {
    await mkdir(dirname(destination), { recursive: true })
    await rename(source, destination)
  }
}
for (const source of await packages(modules)) await movePackage(source, relative(modules, source).replaceAll('\\', '/'))
for (const entry of await readdir(store, { withFileTypes: true })) {
  // .pnpm/node_modules 是 pnpm 的公共链接目录，不是一个 <id>。
  if (!entry.isDirectory() || entry.name === 'node_modules') continue
  const directory = join(store, entry.name, 'node_modules')
  for (const source of await packages(directory))
    await movePackage(source, relative(directory, source).replaceAll('\\', '/'))
}
await rm(store, { recursive: true })
async function removeEmptyDirectories(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory()) await removeEmptyDirectories(join(directory, entry.name))
  if ((await readdir(directory)).length === 0) await rmdir(directory)
}
await removeEmptyDirectories(join(program, 'server'))
const aliasDirectory = join(program, 'server/apps/web/.next/node_modules')
for (const [alias, name] of aliases) {
  const directory = join(aliasDirectory, alias)
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ name: alias, private: true, exports: { '.': { import: './index.mjs', require: './index.cjs' } } }),
  )
  await writeFile(join(directory, 'index.mjs'), `export * from '${name}'\nexport { default } from '${name}'\n`)
  await writeFile(join(directory, 'index.cjs'), `module.exports = require('${name}')\n`)
  // 在发行目录里按包名解析，分别检查 exports 的两条路径；缺默认导出等问题在构建时失败。
  for (const code of [`import(${JSON.stringify(alias)})`, `require(${JSON.stringify(alias)})`])
    await run(process.execPath, ['-e', code], { cwd: dirname(aliasDirectory) })
}
await cp(join(web, '.next/static'), join(program, 'server/apps/web/.next/static'), { recursive: true })
try {
  await lstat(join(web, 'public'))
  await cp(join(web, 'public'), join(program, 'server/apps/web/public'), { recursive: true })
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
}
await cp(cli, join(program, 'cli'), { recursive: true })
// 两个 nextskin.mjs：根目录的是管理进程的入口，版本目录里的是这个版本的启动器的入口（ADR-0039）
await cp(join(packageRoot, 'release/nextskin.mjs'), join(program, 'nextskin.mjs'))
await cp(join(managerRoot, 'release/nextskin.mjs'), join(release, 'nextskin.mjs'))
await cp(join(packageRoot, 'release/.env.example'), join(release, '.env.example'))
await mkdir(join(release, 'manager'))
await cp(join(managerDist, 'main.mjs'), join(release, 'manager/main.mjs'))
// 管理进程的版本号就是同一个 ZIP 里那个版本的：入口按它决定换不换 manager.next/，管理进程按它认出手动解压
await writeFile(join(release, 'manager/VERSION'), version + '\n')

const manifest = JSON.parse(await readFile(join(packageRoot, 'release/package.json'), 'utf8')) as object
await writeFile(join(release, 'package.json'), JSON.stringify({ ...manifest, version }, null, 2) + '\n')
await writeFile(join(program, 'server/VERSION'), version + '\n')
await writeFile(
  join(release, 'README.md'),
  (await readFile(join(packageRoot, 'release/README.md'), 'utf8')).replaceAll('{{version}}', version),
)

for (const file of [
  `releases/${version}/server/apps/web/server.js`,
  `releases/${version}/server/packages/plugin-host/dist/host.mjs`,
  `releases/${version}/server/VERSION`,
  `releases/${version}/nextskin.mjs`,
  `releases/${version}/cli/main.mjs`,
  'nextskin.mjs',
  'manager/main.mjs',
  'manager/VERSION',
])
  if (!(await lstat(join(release, file))).isFile()) throw new Error(`发行目录缺少 ${file}`)
// 指针由管理进程第一次启动时写；带着它，覆盖解压时会把别人站点上的指针换掉（ADR-0061"手动解压"）
for (const file of ['releases/current.json', 'server', 'cli'])
  if (await lstat(join(release, file)).catch(() => null)) throw new Error(`发行目录不该有 ${file}`)
// 发行包必须不含链接和原生模块，才能跨平台解压运行（ADR-0040）。
async function checkDirectory(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.name.startsWith('.env') && path !== join(release, '.env.example'))
      throw new Error(`发行目录带入了构建机配置：${relative(release, path)}`)
    if (path === join(program, 'server/apps/web/data')) throw new Error('发行目录带入了开发数据目录')
    if (entry.isSymbolicLink()) throw new Error(`发行目录含有符号链接：${relative(release, path)}`)
    if (entry.name.endsWith('.node')) throw new Error(`发行目录含有原生模块：${relative(release, path)}`)
    if (entry.isDirectory()) await checkDirectory(path)
  }
}
await checkDirectory(release)
// 经管理进程的入口转给版本目录里的命令行，也直接运行版本目录里的命令行：两条路都要通
for (const entry of [join(release, 'nextskin.mjs'), join(program, 'nextskin.mjs')]) {
  const { stdout } = await run(process.execPath, [entry, 'version'])
  if (!stdout.includes(version)) throw new Error(`${relative(release, entry)} version 没有输出 ${version}`)
}
const smoke = await mkdtemp(join(tmpdir(), 'nextskin-release-'))
try {
  // 避开构建环境的数据库和 .env，只对全新的临时 SQLite 数据目录做冒烟。
  const options = {
    cwd: dirname(smoke),
    env: {
      ...process.env,
      NEXTSKIN_ENV_FILE: join(smoke, 'absent.env'),
      NEXTSKIN_DATA_DIR: smoke,
      NEXTSKIN_DATABASE_URL: `sqlite:${join(smoke, 'nextskin.sqlite')}`,
      NEXTSKIN_SECRET: 'nextskin-build-smoke-secret-32-characters',
    },
  }
  await run(process.execPath, [join(release, 'nextskin.mjs'), 'migrate'], options)
  await run(process.execPath, [join(release, 'nextskin.mjs'), 'doctor'], options)
} catch {
  throw new Error('发行目录的 migrate 或 doctor 冒烟失败；临时 SQLite 数据目录已清理')
} finally {
  await rm(smoke, { recursive: true, force: true })
}
console.log('发行目录产物检查、version、SQLite migrate 和 doctor 冒烟通过')
console.log(`已生成 ${release}`)
