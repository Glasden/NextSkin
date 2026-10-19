/**
 * 把 plugin host 打成一个文件：`dist/host.mjs`（ADR-0033）。
 *
 * standalone 产物里没有 plugin-host 的源码和它的依赖，host 进程又只能读给它的那几个路径，
 * 所以依赖全部打进这一个文件，next.config.ts 再把它带进产物。开发和测试时直接运行源码，不需要这一步
 */
import { rm } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'

const root = fileURLToPath(new URL('..', import.meta.url))
const output = fileURLToPath(new URL('../dist/host.mjs', import.meta.url))

await rm(output, { force: true })
const bundle = await rolldown({
  input: fileURLToPath(new URL('../src/host/main.ts', import.meta.url)),
  platform: 'node',
  cwd: root,
  external: (id) => isBuiltin(id),
  onwarn(warning, warn) {
    if (warning.code === 'UNRESOLVED_IMPORT') throw new Error(`plugin host 的依赖无法解析：${warning.message}`)
    warn(warning)
  },
})
try {
  await bundle.write({ file: output, format: 'esm', codeSplitting: false, minify: false })
} finally {
  await bundle.close()
}
console.log(`已生成 ${output}`)
