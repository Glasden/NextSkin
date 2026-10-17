import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import {
  inferSkinModel,
  renderFigure,
  renderHead,
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
    if (type !== 'cape') cases.push({ name: `${name}-head-k1.png`, render: () => renderHead(image, type, 1) })
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
