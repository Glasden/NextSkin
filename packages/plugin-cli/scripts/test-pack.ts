/**
 * 打包冒烟测试（ADR-0035）：照插件作者的方式，在仓库外用 npm 安装 `pnpm pack` 出来的两个包，
 * 用 TS 6 和 TS 7、nodenext 和 bundler 类型检查一个插件，再用装好的构建命令打成插件包，按核心的规则读回来。
 *
 * 要联网安装依赖，不进 `pnpm check`；CI 的 test:pack 和发布之前（`pnpm release`）都跑它。
 * 失败时临时目录留着，路径打印在最后
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pluginApiRange, unpackPluginPackage } from '@nextskin/plugin-host'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const fixture = fileURLToPath(new URL('../fixtures/external-plugin/', import.meta.url))
// npm、pnpm 在 Windows 上是 .cmd，要经过 shell 才能运行
const shell = process.platform === 'win32'

interface Packed {
  readonly name: string
  readonly version: string
  readonly filename: string
  readonly files: readonly { readonly path: string }[]
}

interface PackageJson {
  readonly name: string
  readonly version: string
  readonly license?: string
  readonly exports?: Record<string, unknown>
  readonly bin?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

function step(title: string) {
  console.log(`\n== ${title}`)
}

function pack(directory: string, destination: string): Packed {
  const output = execFileSync('pnpm', ['pack', '--json', '--pack-destination', destination], {
    cwd: join(repository, directory),
    encoding: 'utf8',
    shell,
  })
  return JSON.parse(output) as Packed
}

/** 包里的文件只能是 `allowed` 里的，`required` 里的都要有 */
function checkFiles(packed: Packed, allowed: readonly RegExp[], required: readonly string[]) {
  const paths = packed.files.map((file) => file.path)
  const extra = paths.filter((path) => !allowed.some((pattern) => pattern.test(path)))
  assert.deepEqual(extra, [], `${packed.name} 的包里有不该发布的文件`)
  const missing = required.filter((path) => !paths.includes(path))
  assert.deepEqual(missing, [], `${packed.name} 的包里缺文件`)
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T
}

const work = await mkdtemp(join(tmpdir(), 'nextskin-test-pack-'))
let passed = false
try {
  step('pnpm pack')
  const tarballs = join(work, 'tarballs')
  const sdk = pack('packages/plugin-sdk', tarballs)
  const cli = pack('packages/plugin-cli', tarballs)
  assert.equal(sdk.version, cli.version, '两个包在 changesets 的 fixed 组里，版本号必须相同')
  checkFiles(
    sdk,
    [
      /^package\.json$/,
      /^README\.md$/,
      /^LICENSE$/,
      /^CHANGELOG\.md$/,
      /^dist\/[a-z-]+\.(?:js|d\.ts)$/,
      /^docs\/.+\.md$/,
    ],
    [
      'package.json',
      'README.md',
      'LICENSE',
      'dist/index.js',
      'dist/index.d.ts',
      // 作者文档随包发布（ADR-0035）
      ...(await readdir(join(repository, 'packages', 'plugin-sdk', 'docs'))).map((name) => `docs/${name}`),
    ],
  )
  checkFiles(
    cli,
    [/^package\.json$/, /^README\.md$/, /^LICENSE$/, /^CHANGELOG\.md$/, /^dist\/cli\.mjs$/],
    ['package.json', 'README.md', 'LICENSE', 'dist/cli.mjs'],
  )

  step('npm install（仓库外的插件项目）')
  const project = join(work, 'project')
  await cp(fixture, project, { recursive: true })
  const manifest = await readJson<PackageJson>(join(project, 'package.json'))
  const typesNode = await readJson<PackageJson>(
    join(repository, 'packages', 'plugin-cli', 'node_modules', '@types', 'node', 'package.json'),
  )
  manifest.dependencies = { '@nextskin/plugin-sdk': `file:${sdk.filename}` }
  manifest.devDependencies = { '@nextskin/plugin-cli': `file:${cli.filename}`, '@types/node': typesNode.version }
  await writeFile(join(project, 'package.json'), JSON.stringify(manifest, null, 2))
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: project,
    stdio: 'inherit',
    shell,
  })

  step('发布出去的 package.json 和 LICENSE')
  const license = await readFile(join(repository, 'LICENSE'), 'utf8')
  for (const name of ['plugin-sdk', 'plugin-cli']) {
    const directory = join(project, 'node_modules', '@nextskin', name)
    const text = await readFile(join(directory, 'package.json'), 'utf8')
    assert.ok(!text.includes('workspace:') && !text.includes('catalog:'), `${name} 的 package.json 里留着 pnpm 的协议`)
    assert.equal(await readFile(join(directory, 'LICENSE'), 'utf8'), license, `${name} 的 LICENSE 和根目录的不一样`)
    assert.equal((JSON.parse(text) as PackageJson).license, 'MIT')
  }
  const sdkJson = await readJson<PackageJson>(join(project, 'node_modules', '@nextskin', 'plugin-sdk', 'package.json'))
  assert.deepEqual(sdkJson.exports?.['.'], { types: './dist/index.d.ts', default: './dist/index.js' })
  const cliJson = await readJson<PackageJson>(join(project, 'node_modules', '@nextskin', 'plugin-cli', 'package.json'))
  assert.deepEqual(cliJson.bin, { 'nextskin-plugin': './dist/cli.mjs' })
  assert.deepEqual(
    Object.keys(cliJson.dependencies ?? {}),
    ['rolldown'],
    '构建命令只应该依赖 rolldown，其余都打进单文件',
  )
  const entry = await readFile(join(project, 'node_modules', '@nextskin', 'plugin-cli', 'dist', 'cli.mjs'), 'utf8')
  assert.ok(entry.startsWith('#!/usr/bin/env node\n'), 'cli.mjs 要以 shebang 开头')

  for (const [compiler, tsc] of [
    ['TS 6', join(repository, 'node_modules', 'typescript', 'bin', 'tsc')],
    ['TS 7', join(repository, 'node_modules', 'typescript-native', 'bin', 'tsc')],
  ] as const) {
    for (const resolution of ['nodenext', 'bundler'] as const) {
      step(`类型检查：${compiler}、${resolution}`)
      const config = `tsconfig.${resolution}.json`
      await writeFile(
        join(project, config),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2023',
            lib: ['ES2023'],
            module: resolution === 'bundler' ? 'preserve' : 'nodenext',
            moduleResolution: resolution,
            strict: true,
            noEmit: true,
            skipLibCheck: false,
            types: ['node'],
          },
          include: ['src'],
        }),
      )
      execFileSync(process.execPath, [tsc, '-p', config], { cwd: project, stdio: 'inherit' })
    }
  }

  step('nextskin-plugin build')
  const out = join(work, 'plugin.tgz')
  // 经过 npm 装好的命令行包装，和插件作者在 package.json 的 scripts 里调用一样
  execFileSync('npm', ['exec', '--offline', '--', 'nextskin-plugin', 'build', '.', '--out', out], {
    cwd: project,
    stdio: 'inherit',
    shell,
  })
  const unpacked = unpackPluginPackage(new Uint8Array(await readFile(out)))
  assert.equal(unpacked.manifest.id, 'pack-fixture')
  assert.equal(unpacked.manifest.api, pluginApiRange(sdk.version))
  assert.deepEqual([...unpacked.files.keys()].sort(), ['locales/zh-CN.json', 'manifest.json', 'server.mjs'])

  passed = true
  console.log(`\ntest:pack 通过：@nextskin/plugin-sdk、@nextskin/plugin-cli ${sdk.version}`)
} finally {
  if (passed) await rm(work, { recursive: true, force: true })
  else console.error(`\ntest:pack 失败，临时目录留在 ${work}`)
}
