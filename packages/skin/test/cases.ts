import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import {
  inferSkinModel,
  renderFigure,
  renderHead,
  renderPose,
  resolutions,
  textureScale,
  type Rgba,
  type TextureType,
} from '../src/index.ts'
import fixtures from './fixtures/manifest.json' with { type: 'json' }
import { patterned } from './helpers.ts'

export const goldenDirectory = new URL('./golden/', import.meta.url)
export const goldenInstruction =
  '渲染输出变了。确认是有意的，就把 RENDERER_VERSION 加 1，再运行 pnpm --filter @nextskin/skin golden'

export interface GoldenManifest {
  version: number
  files: string[]
}

export function readPng(url: URL): Rgba {
  return PNG.sync.read(readFileSync(url))
}

export function encodePng(image: Rgba): Uint8Array {
  return PNG.sync.write(
    Object.assign(new PNG({ width: image.width, height: image.height }), { data: Buffer.from(image.data) }),
  )
}

export interface GoldenCase {
  name: string
  render: () => Rgba
}

export function goldenCases(): GoldenCase[] {
  const cases: GoldenCase[] = []
  function add(name: string, image: Rgba, type: TextureType) {
    const s = textureScale(type, image.width, image.height)
    const ks = resolutions(s)
    const selected = type === 'cape' ? [1] : [...new Set([1, ks[Math.floor(ks.length / 2)]!, s])]
    for (const k of selected)
      cases.push({ name: `${name}-figure-k${k}.png`, render: () => renderFigure(image, type, k) })
    if (type === 'cape') return
    cases.push({ name: `${name}-head-k1.png`, render: () => renderHead(image, type, 1) })
    // 3D 出图：抬手拼图的第 0 帧就是静止图，所以只存拼图；高清皮肤再存一张 p 等于 s 的。
    // 合成的花纹材质几乎压不动，3D 出图只用真实材质
    if (name.startsWith('synthetic')) return
    cases.push({ name: `${name}-both-raise-p4.png`, render: () => renderPose(image, type, 'both', 4, true) })
    cases.push({ name: `${name}-front-raise-p3.png`, render: () => renderPose(image, type, 'front', 3, true) })
    if (s > 1) cases.push({ name: `${name}-both-p${s}.png`, render: () => renderPose(image, type, 'both', s, false) })
  }
  for (const file of Object.keys(fixtures)) {
    const image = readPng(new URL(`./fixtures/${file}`, import.meta.url))
    add(file.slice(0, -4), image, file.includes('cape') ? 'cape' : inferSkinModel(image))
  }
  add('synthetic-hd-cape', patterned(128, 64), 'cape')
  add('synthetic-legacy-hd', patterned(256, 128), 'steve')
  add('synthetic-22x17-cape', patterned(66, 51), 'cape')
  return cases
}

/** 随核心发布的材质（assets/）预先渲染的出图，网页直接当静态文件引用：空站点的登录页、安装页、维护页插图用它 */
export const assetFigureDirectory = new URL('../assets/figures/', import.meta.url)
export const assetInstruction =
  '随核心发布的材质拼图过期了。渲染器升级后运行 pnpm --filter @nextskin/skin assets（AGENTS.md）'

export interface AssetFigureManifest {
  rendererVersion: number
  figures: Record<string, { type: TextureType; textureScale: number }>
}

const ASSET_SKINS = ['default-skin'] as const
// 插图只显示正面，按 ×4、×8 显示，1x、2x 两档
export const ASSET_DENSITIES = [4, 8, 16] as const

export function assetFigures() {
  return ASSET_SKINS.map((name) => {
    const image = readPng(new URL(`../assets/${name}.png`, import.meta.url))
    const type = inferSkinModel(image)
    const s = textureScale(type, image.width, image.height)
    return {
      name,
      type,
      textureScale: s,
      files: ASSET_DENSITIES.flatMap((p) =>
        [false, true].map((raise) => ({
          file: `${name}-front${raise ? '-raise' : ''}-p${p}.png`,
          render: () => renderPose(image, type, 'front', p, raise),
        })),
      ),
    }
  })
}
