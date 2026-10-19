import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative, sep } from 'node:path'

interface PackageDependencies {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

/** 只放行运行时依赖各自的 pnpm 层；根 node_modules 的工作区链接会让权限越界。 */
function sourceReadPaths(root: string): string[] {
  root = realpathSync(root)
  const packages = join(root, 'packages')
  const host = join(packages, 'plugin-host')
  const sdk = join(packages, 'plugin-sdk')
  const store = join(root, 'node_modules', '.pnpm')
  const paths = new Set([host, sdk])
  const visited = new Set<string>()

  function visit(dir: string) {
    if (visited.has(dir)) return
    visited.add(dir)
    const manifest = join(dir, 'package.json')
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as PackageDependencies
    const required = { ...pkg.dependencies }
    const optional = { ...(dir !== host && dir !== sdk && pkg.peerDependencies), ...pkg.optionalDependencies }
    const require = createRequire(manifest)
    for (const name of new Set([...Object.keys(required), ...Object.keys(optional)])) {
      // package.json 可能不在 exports 里：按 Node 的查找目录定位包，再解析符号链接。
      let dependency: string | undefined
      for (const lookup of require.resolve.paths(name) ?? []) {
        try {
          dependency = realpathSync(join(lookup, name))
          break
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        }
      }
      if (!dependency) {
        if (Object.hasOwn(optional, name)) continue
        throw new Error(`plugin host 缺少运行时依赖 ${name}`)
      }
      if (dependency === packages || dependency.startsWith(packages + sep)) {
        if (dependency !== sdk) throw new Error(`plugin host 不允许读取工作区依赖 ${name}`)
      } else {
        const parts = relative(store, dependency).split(sep)
        if (parts[0] === '..' || parts[1] !== 'node_modules' || parts.length < 3)
          throw new Error(`plugin host 的第三方依赖 ${name} 不在 pnpm 包目录内`)
        paths.add(join(store, parts[0]!, 'node_modules'))
      }
      visit(dependency)
    }
  }

  visit(host)
  visit(sdk)
  return [...paths]
}

/**
 * plugin host 进程的入口和它能读的路径（ADR-0009：只能读自己的代码和插件目录）。
 *
 * - 开发和测试：Node 直接运行 `src/host/main.ts`，要读 plugin-host、plugin-sdk 的源码和运行时依赖在 `.pnpm` 里的那一层
 *   （不放行整个 node_modules：pnpm 在里面放了指向 apps/web 等工作区包的链接，权限模型会跟着链接走，见 sourceReadPaths）；
 * - standalone 产物：运行打好包的 `dist/host.mjs`（`pnpm build` 生成，next.config.ts 把它带进产物），只读这一个文件。
 *
 * `root` 是仓库根目录，standalone 产物里是产物的根目录：两者的目录结构相同。
 * Next 打包后的代码里 `import.meta.url` 不是源文件的位置，所以由调用方按工作目录给出
 */
export function pluginHostEntry(options: { root: string; bundled: boolean }): {
  script: string
  readPaths: string[]
} {
  const host = join(options.root, 'packages', 'plugin-host')
  if (options.bundled) {
    const script = join(host, 'dist', 'host.mjs')
    return { script, readPaths: [script] }
  }
  // 可读路径都是解析过链接的真实路径，入口也要用真实路径，否则根目录经过链接时 host 读不到自己
  return {
    script: join(realpathSync(options.root), 'packages', 'plugin-host', 'src', 'host', 'main.ts'),
    readPaths: sourceReadPaths(options.root),
  }
}
