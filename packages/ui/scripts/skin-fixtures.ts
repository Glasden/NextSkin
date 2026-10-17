/**
 * 用 @nextskin/skin 把它的测试材质渲染成正背面拼图，给 SkinFigure 的 story 和截图用（ADR-0017）。
 * 渲染器升级（RENDERER_VERSION 变了）后运行 `pnpm --filter @nextskin/ui skin:fixtures`，否则 ui 的测试会失败。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import {
  inferSkinModel,
  RENDERER_VERSION,
  renderFigure,
  resolutions,
  textureScale,
  type TextureType,
} from '@nextskin/skin'
import { PNG } from 'pngjs'

// 经典、纤细、旧版 64×32、旧版高清各一张，加两张披风
const SOURCES = [
  { name: 'haka', kind: 'skin' },
  { name: 'hatsune_miku', kind: 'skin' },
  { name: 'sethbling', kind: 'skin' },
  { name: 'ironman_hd', kind: 'skin' },
  { name: 'mojang_cape', kind: 'cape' },
  { name: 'legacy_cape', kind: 'cape' },
] as const

const fixtures = new URL('../../skin/test/fixtures/', import.meta.url)
const outDir = new URL('../src/skin-figure/fixtures/', import.meta.url)

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const figures: Record<string, { type: TextureType; textureScale: number }> = {}
for (const { name, kind } of SOURCES) {
  const png = PNG.sync.read(readFileSync(new URL(`${name}.png`, fixtures)))
  const image = { width: png.width, height: png.height, data: new Uint8Array(png.data) }
  const type = kind === 'cape' ? 'cape' : inferSkinModel(image)
  const s = textureScale(type, image.width, image.height)
  for (const k of resolutions(s)) {
    const figure = renderFigure(image, type, k)
    const out = new PNG({ width: figure.width, height: figure.height })
    out.data = Buffer.from(figure.data)
    writeFileSync(new URL(`${name}-k${k}.png`, outDir), PNG.sync.write(out))
  }
  figures[name] = { type, textureScale: s }
}
writeFileSync(
  new URL('manifest.json', outDir),
  `${JSON.stringify({ rendererVersion: RENDERER_VERSION, figures }, null, 2)}\n`,
)
console.log(`${Object.keys(figures).length} 张材质，渲染器版本 ${RENDERER_VERSION}`)
