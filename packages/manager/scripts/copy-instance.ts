import { cp, mkdir, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [directory, ...extra] = process.argv.slice(2)
if (!directory || extra.length) throw new Error('用法：node copy-instance.ts <空实例目录>')
const source = fileURLToPath(new URL('../../../dist/nextskin/', import.meta.url))
const target = resolve(directory)
// 实例必须在发行目录之外，避免复制自身或写坏发布产物。
if (target === source.slice(0, -1) || target.startsWith(source)) throw new Error('实例目录不能位于 dist/nextskin 内')
await mkdir(target, { recursive: true })
if ((await readdir(target)).length) throw new Error('实例目录必须不存在或为空')
await cp(source, target, { recursive: true, force: false })
