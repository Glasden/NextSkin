import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { assets, CDP_PORT, drawMarks, type Box, type Mark } from './common.ts'

// 用法：node screenshots/install/annotate.ts <原图.png> <输出名> '<JSON>'
// 在已经截好的图上重画标注，不用回到面板上重走一遍：例如序号被裁掉了，先把原图扩边，再按新的坐标画。
// JSON 是 { "marks": Mark[], "clip"?: Box }，坐标按原图的像素；输出写到 src/assets/install/<输出名>.png

const [source, name, json] = process.argv.slice(2)
if (!source || !name || !json)
  throw new Error("用法：node screenshots/install/annotate.ts <原图.png> <输出名> '<JSON>'")
const spec = JSON.parse(json) as { marks: Mark[]; clip?: Box }

const png = readFileSync(source)
// PNG 的 IHDR 紧跟在 8 字节的文件头和 8 字节的块头后面：宽、高各 4 字节
const size = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`)
const context = browser.contexts()[0]
if (!context) throw new Error('连不上浏览器：先运行 browser.ts')
const page = await context.newPage()
try {
  await page.setViewportSize(size)
  await page.setContent(
    `<style>html,body{margin:0}img{display:block}</style><img src="data:image/png;base64,${png.toString('base64')}">`,
  )
  await page.locator('img').evaluate((img: HTMLImageElement) => img.decode())
  await drawMarks(page, spec.marks)
  const path = join(assets, `${name}.png`)
  await page.screenshot({ path, clip: spec.clip })
  console.log('成品', path)
} finally {
  await page.close()
  await browser.close().catch(() => {})
}
