/**
 * 模拟 `nextskin-plugin build` 的前端部分：把 plugins/{id}/client.tsx 打成单文件 ESM，
 * 共享模块设为外部依赖；需要时用 Tailwind 生成插件自己的工具类 CSS。产物和 installed.json 写到 data/plugins。
 *
 * 运行：node scripts/build-plugins.ts
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import * as esbuild from 'esbuild'
import { init as initLexer, parse as parseModule } from 'es-module-lexer'

interface PluginJson {
  readonly id: string
  readonly versions?: readonly string[]
  readonly widgets: readonly { readonly slot: string; readonly export: string }[]
  /** 构建 Tailwind 工具类 CSS */
  readonly css?: boolean
  /** 反例：把 React 打进插件包，不用宿主那一份 */
  readonly bundleShared?: boolean
  /** 额外的外部依赖（反例用：import map 里没有的裸模块名） */
  readonly externals?: readonly string[]
  /** 反例：算完 integrity 之后再改文件 */
  readonly tamper?: boolean
  /** 反例：登记了，但文件不存在 */
  readonly missing?: boolean
  /** 测试夹具：故意导入共享模块以外的东西（见 foreignImports），安装检查对它只记录、不拒绝 */
  readonly fixtureForeignImports?: boolean
}

const SHARED = ['react', 'react/jsx-runtime', 'react/compiler-runtime', 'react-dom', '@nextskin/ui', '@nextskin/plugin-client']

const root = path.resolve(import.meta.dirname, '..')
const outRoot = path.join(root, 'data/plugins')
const tailwind = path.join(root, 'node_modules/.bin/tailwindcss')

const sri = (bytes: Buffer | string) => `sha384-${createHash('sha384').update(bytes).digest('base64')}`

await initLexer()

/**
 * 安装检查（正式实现里由核心在安装时做，不信任插件自己的构建工具）：入口只允许静态导入共享模块，不允许 import()。
 * integrity 只覆盖入口文件本身，所以只有满足这一条，"入口与安装时登记的字节一致"才等于"插件的全部代码与登记的一致"。
 * 它约束的是登记的代码长什么样，约束不了这段代码运行时做什么（例如插入 <script>，见 README 的 CSP 一节）。
 */
function foreignImports(code: string): string[] {
  const [imports] = parseModule(code)
  const foreign: string[] = []
  for (const imp of imports) {
    if (imp.type === 'import-meta') continue
    if (imp.type === 'dynamic') foreign.push(`import(${imp.specifier ?? '…'})`)
    else if (!SHARED.includes(imp.specifier)) foreign.push(imp.specifier)
  }
  return foreign
}

await rm(outRoot, { recursive: true, force: true })
await mkdir(outRoot, { recursive: true })

const installed: {
  plugins: Record<string, { defaultVersion: string; versions: Record<string, { client: Asset; css: Asset | null; foreignImports: string[] }> }>
  widgets: { plugin: string; slot: string; export: string }[]
} = { plugins: {}, widgets: [] }
interface Asset {
  url: string
  integrity: string
  bytes: number
}

const report: string[] = []
for (const dir of (await readdir(path.join(root, 'plugins'))).sort()) {
  const pluginDir = path.join(root, 'plugins', dir)
  if (!(await stat(pluginDir)).isDirectory()) continue
  const meta = JSON.parse(await readFile(path.join(pluginDir, 'plugin.json'), 'utf8')) as PluginJson
  const versions = meta.versions ?? ['1.0.0']
  installed.plugins[meta.id] = { defaultVersion: versions[0]!, versions: {} }
  for (const widget of meta.widgets) installed.widgets.push({ plugin: meta.id, ...widget })

  for (const version of versions) {
    const outDir = path.join(outRoot, meta.id, version)
    const base = `/plugins-assets/${meta.id}/${version}`
    await mkdir(outDir, { recursive: true })
    if (meta.missing) {
      installed.plugins[meta.id]!.versions[version] = {
        client: { url: `${base}/client.js`, integrity: sri('missing'), bytes: 0 },
        css: null,
        foreignImports: [],
      }
      continue
    }

    const outfile = path.join(outDir, 'client.js')
    await esbuild.build({
      entryPoints: [path.join(pluginDir, 'client.tsx')],
      outfile,
      bundle: true,
      // 单文件：每个入口只有一个 integrity，不产生没有校验的懒加载分块
      splitting: false,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      jsx: 'automatic',
      minify: true,
      legalComments: 'none',
      external: [...(meta.bundleShared ? [] : SHARED), ...(meta.externals ?? [])],
      define: { __VERSION__: JSON.stringify(version), 'process.env.NODE_ENV': '"production"' },
      logLevel: 'warning',
    })
    let code = await readFile(outfile)
    const foreign = foreignImports(code.toString('utf8'))
    if (foreign.length > 0 && !meta.fixtureForeignImports) {
      throw new Error(`${meta.id}@${version} 的入口导入了共享模块以外的东西：${foreign.join(', ')}`)
    }
    const client: Asset = { url: `${base}/client.js`, integrity: sri(code), bytes: code.length }
    if (meta.tamper) {
      // 模拟发布后被篡改：integrity 仍是原文件的
      await appendFile(outfile, '\nglobalThis.__s3_tampered = true\n')
      code = await readFile(outfile)
    }

    let css: Asset | null = null
    if (meta.css) {
      const input = path.join(outDir, 'tailwind.input.css')
      await writeFile(
        input,
        [
          // @reference 只取 token、变体和默认刻度，不输出 preflight 和 :root 变量；source(none) 关掉自动扫描，只输出插件源码里用到的工具类
          `@reference "tailwindcss";`,
          `@reference "${path.join(root, 'packages/ui/src/theme.css')}";`,
          `@import "tailwindcss/utilities" layer(utilities) source(none);`,
          `@source "${pluginDir}";`,
          '',
        ].join('\n'),
      )
      const cssFile = path.join(outDir, 'client.css')
      execFileSync(tailwind, ['-i', input, '-o', cssFile, '--minify'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] })
      await rm(input)
      const bytes = await readFile(cssFile)
      css = { url: `${base}/client.css`, integrity: sri(bytes), bytes: bytes.length }
    }

    installed.plugins[meta.id]!.versions[version] = { client, css, foreignImports: foreign }
    report.push(`  ${meta.id}@${version}: client.js ${(code.length / 1024).toFixed(1)} KiB${css ? `, client.css ${(css.bytes / 1024).toFixed(1)} KiB` : ''}`)
  }
}

await writeFile(path.join(outRoot, 'installed.json'), JSON.stringify(installed, null, 2))
await writeFile(path.join(outRoot, 'active.json'), '{}\n')
console.log('plugins → data/plugins')
console.log(report.join('\n'))
