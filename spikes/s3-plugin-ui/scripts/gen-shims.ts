/**
 * 生成 import map 指向的 shim：每个共享模块一个 ESM 文件，导出 globalThis 上登记的宿主实例。
 *
 * ESM 的具名导出必须静态列出，所以导出名在这里算好：
 * - React 系：取 Next 自带那一份（next/dist/compiled/react{,-experimental}）开发版和生产版导出名的并集。
 *   用哪个通道和 Next 的判断一致（needsExperimentalReact），通道由 REACT_CHANNEL 指定，默认稳定通道。
 * - 自有包：用 esbuild 的 metafile 读出 ESM 导出名，不执行代码。
 * tests/s3.spec.ts 会在浏览器里按运行模式（开发版/生产版）核对宿主实际对象的键与这里记下的完全一致，
 * Next 升级后导出变了、或者升级后忘了重新生成，测试都会失败。
 *
 * 运行：node scripts/gen-shims.ts
 */
import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import * as esbuild from 'esbuild'

const root = path.resolve(import.meta.dirname, '..')
const outDir = path.join(root, 'data/shims')
const require = createRequire(import.meta.url)
const channel = process.env.REACT_CHANNEL === 'experimental' ? '-experimental' : ''

const exportNames = (keys: Iterable<string>) => [...keys].filter((k) => k !== 'default' && k !== '__esModule').sort()

/** 开发版和生产版各自的导出名。shim 导出两者的并集；测试按运行模式逐个精确比较 */
function devAndProd(pkg: string, name: string): { dev: string[]; prod: string[] } {
  const load = (build: string) => exportNames(Object.keys(require(`next/dist/compiled/${pkg}${channel}/cjs/${name}.${build}.js`)))
  return { dev: load('development'), prod: load('production') }
}

/** 自有包不区分开发版和生产版 */
const same = (names: string[]) => ({ dev: exportNames(names), prod: exportNames(names) })

async function esmExports(entry: string): Promise<string[]> {
  const result = await esbuild.build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    write: false,
    format: 'esm',
    packages: 'external',
    jsx: 'automatic',
    metafile: true,
    outdir: 'out',
    logLevel: 'silent',
  })
  const [output] = Object.values(result.metafile.outputs)
  if (output === undefined) throw new Error(`esbuild 没有输出：${entry}`)
  return output.exports
}

const modules: Record<string, { dev: string[]; prod: string[] }> = {
  react: devAndProd('react', 'react'),
  'react/jsx-runtime': devAndProd('react', 'react-jsx-runtime'),
  'react/compiler-runtime': devAndProd('react', 'react-compiler-runtime'),
  'react-dom': devAndProd('react-dom', 'react-dom'),
  '@nextskin/ui': same(await esmExports('packages/ui/src/index.ts')),
  '@nextskin/plugin-client': same(await esmExports('packages/plugin-client/src/index.ts')),
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

function shimSource(name: string, names: readonly string[]): string {
  const bad = names.filter((k) => !IDENTIFIER.test(k))
  if (bad.length > 0) throw new Error(`${name} 的导出名不是合法标识符：${bad.join(', ')}`)
  return [
    '// 由 scripts/gen-shims.ts 生成，不要手改',
    `const m = globalThis[Symbol.for('nextskin.shared')]?.[${JSON.stringify(name)}]`,
    `if (m === undefined) throw new Error(${JSON.stringify(`[nextskin] 共享模块 ${name} 尚未登记`)})`,
    'export default m.default ?? m',
    names.length > 0 ? `export const { ${names.join(', ')} } = m` : '',
    '',
  ].join('\n')
}

await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

const imports: Record<string, string> = {}
const integrity: Record<string, string> = {}
const keys: Record<string, { dev: string[]; prod: string[] }> = {}
for (const [name, builds] of Object.entries(modules)) {
  const source = shimSource(name, [...new Set([...builds.dev, ...builds.prod])].sort())
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 10)
  const file = `${name.replace(/^@/, '').replace(/\//g, '__')}.${hash}.js`
  await writeFile(path.join(outDir, file), source)
  const url = `/plugins-assets/_shared/${file}`
  imports[name] = url
  integrity[url] = `sha384-${createHash('sha384').update(source).digest('base64')}`
  keys[name] = builds
}

const reactVersion = (require(`next/dist/compiled/react${channel}`) as { version: string }).version
await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify({ reactVersion, imports, integrity, keys }, null, 2))
console.log(`shims → data/shims（React ${reactVersion}）`)
for (const [name, { dev, prod }] of Object.entries(keys)) console.log(`  ${name}: 开发版 ${dev.length} 个导出，生产版 ${prod.length} 个`)
