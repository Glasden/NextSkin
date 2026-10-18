/**
 * 用 @nextskin/skin 把它的测试材质和默认皮肤渲染成正背面拼图和头像，给 SkinFigure、PlayerHead、TextureCard 的
 * story 和截图用（ADR-0017、ADR-0025）。
 * 渲染器升级（RENDERER_VERSION 变了）后运行 `pnpm --filter @nextskin/ui skin:fixtures`，否则 ui 的测试会失败。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import {
  inferSkinModel,
  RENDERER_VERSION,
  renderFigure,
  renderHead,
  resolutions,
  textureScale,
  type TextureType,
} from '@nextskin/skin'
import { PNG } from 'pngjs'

const fixtures = new URL('../../skin/test/fixtures/', import.meta.url)
const assets = new URL('../../skin/assets/', import.meta.url)

// 测试材质：经典、纤细、旧版 64×32、旧版高清各一张，加两张披风；再加随核心发布的默认皮肤（登录页插图）
const SOURCES = [
  { name: 'haka', kind: 'skin', dir: fixtures },
  { name: 'hatsune_miku', kind: 'skin', dir: fixtures },
  { name: 'sethbling', kind: 'skin', dir: fixtures },
  { name: 'ironman_hd', kind: 'skin', dir: fixtures },
  { name: 'mojang_cape', kind: 'cape', dir: fixtures },
  { name: 'legacy_cape', kind: 'cape', dir: fixtures },
  { name: 'default-skin', kind: 'skin', dir: assets },
] as const

const outDir = new URL('../src/skin-figure/fixtures/', import.meta.url)

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

function write(file: string, image: { width: number; height: number; data: Uint8Array }) {
  const out = new PNG({ width: image.width, height: image.height })
  out.data = Buffer.from(image.data)
  writeFileSync(new URL(file, outDir), PNG.sync.write(out))
}

const figures: Record<string, { type: TextureType; textureScale: number }> = {}
for (const { name, kind, dir } of SOURCES) {
  const png = PNG.sync.read(readFileSync(new URL(`${name}.png`, dir)))
  const image = { width: png.width, height: png.height, data: new Uint8Array(png.data) }
  const type = kind === 'cape' ? 'cape' : inferSkinModel(image)
  const s = textureScale(type, image.width, image.height)
  for (const k of resolutions(s)) {
    write(`${name}-k${k}.png`, renderFigure(image, type, k))
    if (type !== 'cape') write(`${name}-head-k${k}.png`, renderHead(image, type, k))
  }
  figures[name] = { type, textureScale: s }
}
writeFileSync(
  new URL('manifest.json', outDir),
  `${JSON.stringify({ rendererVersion: RENDERER_VERSION, figures }, null, 2)}\n`,
)
console.log(`${Object.keys(figures).length} 张材质，渲染器版本 ${RENDERER_VERSION}`)
