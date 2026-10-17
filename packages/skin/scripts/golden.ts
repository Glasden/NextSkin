import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { RENDERER_VERSION } from '../src/index.ts'
import {
  encodePng,
  goldenCases,
  goldenDirectory,
  goldenInstruction,
  readPng,
  type GoldenManifest,
} from '../test/cases.ts'
import { samePixels } from '../test/helpers.ts'

const manifestUrl = new URL('manifest.json', goldenDirectory)
const previous = existsSync(manifestUrl) ? (JSON.parse(readFileSync(manifestUrl, 'utf8')) as GoldenManifest) : undefined
const rendered = goldenCases().map(({ name, render }) => ({ name, image: render() }))
const files = rendered.map(({ name }) => name)
const changed =
  previous !== undefined &&
  (JSON.stringify(previous.files) !== JSON.stringify(files) ||
    rendered.some(({ name, image }) => {
      const url = new URL(name, goldenDirectory)
      return !existsSync(url) || !samePixels(image, readPng(url))
    }))
// 先完成所有比较，再写任何文件，拒绝时不会留下半套基线。
if (changed && RENDERER_VERSION <= previous.version) throw new Error(goldenInstruction)
if (previous && !changed && previous.version === RENDERER_VERSION) {
  console.log(`黄金图无变化：${files.length} 张，版本 ${RENDERER_VERSION}`)
} else {
  mkdirSync(goldenDirectory, { recursive: true })
  for (const { name, image } of rendered) writeFileSync(new URL(name, goldenDirectory), encodePng(image))
  writeFileSync(
    manifestUrl,
    JSON.stringify({ version: RENDERER_VERSION, files } satisfies GoldenManifest, null, 2) + '\n',
  )
  console.log(`已生成 ${files.length} 张黄金图，版本 ${RENDERER_VERSION}`)
}
