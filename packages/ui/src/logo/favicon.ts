import { zlibSync } from 'fflate'
import type { ThemeTokens } from '../tokens.ts'
import { LOGO_MARK, LOGO_MARK_COLORS, LOGO_MARK_SIZE, logoMarkRects } from './mark.ts'

/**
 * 站点图标，由标志的图形和 theme.css 的颜色生成（ADR-0032）。`pnpm design:sync` 把结果写进 apps/web/app/，
 * favicon.test.ts 检查那里的文件和这里生成的一致。只给生成脚本和测试用，不从包入口导出
 */
export interface Favicons {
  /** 跟着浏览器切换亮暗 */
  svg: string
  /** 16、32、48 三种尺寸，亮色，给不认 SVG 图标的浏览器 */
  ico: Uint8Array
  /** 180×180，iOS 主屏幕；iOS 会把透明的部分填成黑色，所以铺 surface 的底色 */
  appleIcon: Uint8Array
}

const ICO_SIZES = [16, 32, 48]
const APPLE_SIZE = 180
const APPLE_CELL = 16

type Palette = Record<string, string>

function palettes(theme: ThemeTokens) {
  const light: Palette = {}
  const dark: Palette = {}
  for (const name of [...Object.values(LOGO_MARK_COLORS), 'surface']) {
    const token = theme.colors.find((color) => color.name === name)
    if (!token?.dark) throw new Error(`theme.css 里缺少颜色 ${name} 的亮色或暗色取值`)
    light[name] = token.light
    dark[name] = token.dark
  }
  return { light, dark }
}

function svg(light: Palette, dark: Palette) {
  const fills = (palette: Palette) =>
    Object.values(LOGO_MARK_COLORS)
      .map((name) => `.${name}{fill:${palette[name]}}`)
      .join('')
  const rects = logoMarkRects()
    .map((rect) => `<rect class="${rect.color}" x="${rect.x}" y="${rect.y}" width="${rect.width}" height="1"/>`)
    .join('')
  return (
    '<!-- 由 pnpm design:sync 生成，不要手改（ADR-0032） -->\n' +
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${LOGO_MARK_SIZE} ${LOGO_MARK_SIZE}" shape-rendering="crispEdges">` +
    `<style>${fills(light)}@media (prefers-color-scheme:dark){${fills(dark)}}</style>${rects}</svg>\n`
  )
}

const rgba = (hex: string): [number, number, number, number] => {
  if (!/^#[\da-f]{6}$/i.test(hex)) throw new Error(`颜色必须是 #rrggbb：${hex}`)
  return [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)).concat(255) as [
    number,
    number,
    number,
    number,
  ]
}

/** 标志放在 size×size 的画布正中，每格 cell 像素；background 为空时是透明底 */
function raster(size: number, cell: number, palette: Palette, background?: string) {
  const offset = (size - LOGO_MARK_SIZE * cell) / 2
  if (!Number.isInteger(offset)) throw new Error(`标志放不进 ${size} 像素的正中`)
  const pixels = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = Math.floor((x - offset) / cell)
      const cy = Math.floor((y - offset) / cell)
      const key = LOGO_MARK[cy]?.[cx]
      const name = key && key !== '.' ? LOGO_MARK_COLORS[key as keyof typeof LOGO_MARK_COLORS] : undefined
      const color = name ? palette[name]! : background
      if (color) pixels.set(rgba(color), (y * size + x) * 4)
    }
  }
  return pixels
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes: Uint8Array) {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function chunk(type: string, data: Uint8Array) {
  const body = concat([new TextEncoder().encode(type), data])
  const out = new Uint8Array(body.length + 8)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(body, 4)
  view.setUint32(body.length + 4, crc32(body))
  return out
}

/** RGBA8 的 PNG，每行不做滤波；图标只有几种颜色，deflate 压得很小 */
function png(size: number, pixels: Uint8Array) {
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, size)
  view.setUint32(4, size)
  header.set([8, 6, 0, 0, 0], 8)
  const rows = new Uint8Array(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) rows.set(pixels.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1)
  return concat([
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk('IHDR', header),
    chunk('IDAT', zlibSync(rows, { level: 9 })),
    chunk('IEND', new Uint8Array()),
  ])
}

/** ICO 里直接放 PNG（Windows Vista 起的浏览器都认） */
function ico(images: { size: number; png: Uint8Array }[]) {
  const header = new Uint8Array(6 + 16 * images.length)
  const view = new DataView(header.buffer)
  view.setUint16(2, 1, true)
  view.setUint16(4, images.length, true)
  let offset = header.length
  images.forEach((image, index) => {
    const entry = 6 + 16 * index
    header[entry] = image.size
    header[entry + 1] = image.size
    view.setUint16(entry + 4, 1, true)
    view.setUint16(entry + 6, 32, true)
    view.setUint32(entry + 8, image.png.length, true)
    view.setUint32(entry + 12, offset, true)
    offset += image.png.length
  })
  return concat([header, ...images.map((image) => image.png)])
}

export function renderFavicons(theme: ThemeTokens): Favicons {
  const { light, dark } = palettes(theme)
  return {
    svg: svg(light, dark),
    ico: ico(ICO_SIZES.map((size) => ({ size, png: png(size, raster(size, size / LOGO_MARK_SIZE, light)) }))),
    appleIcon: png(APPLE_SIZE, raster(APPLE_SIZE, APPLE_CELL, light, light.surface)),
  }
}

/** 生成的文件在 apps/web/app/ 下的名字：Next 按文件名生成 `<link rel="icon">` */
export const FAVICON_FILES = { svg: 'icon.svg', ico: 'favicon.ico', appleIcon: 'apple-icon.png' } as const
