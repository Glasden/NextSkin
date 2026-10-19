#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { buildPluginPackage } from './build.ts'

function usage(): never {
  console.error('用法：nextskin-plugin build [目录] [--out <文件>]')
  process.exit(2)
}

const args = process.argv.slice(2)
if (args.shift() !== 'build') usage()
let dir: string | undefined
let out: string | undefined
while (args.length) {
  const arg = args.shift()!
  if (arg === '--out') {
    if (out !== undefined || !args[0] || args[0].startsWith('-')) usage()
    out = args.shift()!
  } else if (arg.startsWith('-') || dir !== undefined) usage()
  else dir = arg
}
try {
  const root = resolve(dir ?? '.')
  const result = await buildPluginPackage({ dir: root })
  const output =
    out === undefined ? join(root, 'dist', `${result.manifest.id}-${result.manifest.version}.tgz`) : resolve(out)
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, result.bytes)
  console.log(`已生成 ${output}`)
  console.log(`sha256: ${result.sha256}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : '插件构建失败')
  process.exitCode = 1
}
