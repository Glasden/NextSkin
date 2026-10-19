/**
 * 把构建命令打成一个文件：`dist/cli.mjs`，发布到 npm 的就是它（ADR-0035）。
 *
 * plugin-host、SDK 和 zod 都打进来：构建时插件代码里的 SDK、zod 换成这一份，和 host 运行插件时一样，
 * plugin-host 也不用单独发布。只有 rolldown 留在外面，它带着按平台安装的原生绑定。
 * 仓库里直接运行 `src/cli.ts`，不需要这一步
 */
import { rm } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'

const root = fileURLToPath(new URL('..', import.meta.url))
const output = fileURLToPath(new URL('../dist/cli.mjs', import.meta.url))
const external = (id: string) => isBuiltin(id) || id === 'rolldown' || id.startsWith('rolldown/')

await rm(output, { force: true })
const bundle = await rolldown({
  input: fileURLToPath(new URL('../src/cli.ts', import.meta.url)),
  platform: 'node',
  cwd: root,
  external,
  onwarn(warning, warn) {
    if (warning.code === 'UNRESOLVED_IMPORT') throw new Error(`构建命令的依赖无法解析：${warning.message}`)
    warn(warning)
  },
})
try {
  await bundle.write({ file: output, format: 'esm', codeSplitting: false, minify: false })
} finally {
  await bundle.close()
}
console.log(`已生成 ${output}`)
