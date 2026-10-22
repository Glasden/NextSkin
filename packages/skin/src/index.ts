import { over } from './composite.ts'

/** 解码好的 RGBA8 像素，按行存储，data.length === width * height * 4。 */
export interface Rgba {
  readonly width: number
  readonly height: number
  readonly data: Uint8Array
}

/** 与数据库 textures.type 和插件 SDK 相同。 */
export type TextureType = 'steve' | 'alex' | 'cape'

/** 任何函数的输出像素变化时加 1；出图地址和缓存键包含它（ADR-0017）。 */
export const RENDERER_VERSION = 3

/** 材质形状或渲染分辨率不合法。 */
export class TextureShapeError extends Error {
  override name = 'TextureShapeError'
}

/** 校验尺寸并返回一个标准像素占据的整数倍数 s，不施加上传资源预算。 */
export function textureScale(type: TextureType, width: number, height: number): number {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new TextureShapeError('材质宽高必须是正整数')
  }
  if (type === 'cape') {
    if (width % 64 === 0 && height === width / 2) return width / 64
    if (width % 22 === 0 && height === (width / 22) * 17) return width / 22
    throw new TextureShapeError('披风尺寸必须是 64×32 或 22×17 的整数倍')
  }
  if (width % 64 === 0 && (height === width || height === width / 2)) return width / 64
  throw new TextureShapeError('皮肤宽度必须是 64 的整数倍，高度必须等于宽度或宽度的一半')
}

function imageScale(image: Rgba, type: TextureType): number {
  const s = textureScale(type, image.width, image.height)
  if (image.data.length !== image.width * image.height * 4) {
    throw new TextureShapeError('RGBA 像素长度必须等于宽度 × 高度 × 4')
  }
  return s
}

function blank(width: number, height: number): Rgba {
  return { width, height, data: new Uint8Array(width * height * 4) }
}

// skinview-utils 0.7.1 的四个手臂空白区；在客户端修正 alpha 之前判断。
const armGaps = [
  [50, 16, 2, 4],
  [54, 20, 2, 12],
  [42, 48, 2, 4],
  [46, 52, 2, 12],
] as const

/** 推断经典/纤细模型。旧格式一律是 steve；对原始像素调用。 */
export function inferSkinModel(image: Rgba): 'steve' | 'alex' {
  const s = imageScale(image, 'steve')
  if (image.height !== image.width) return 'steve'
  let black = true
  let white = true
  for (const [x, y, w, h] of armGaps) {
    for (let yy = y * s; yy < (y + h) * s; yy++) {
      for (let xx = x * s; xx < (x + w) * s; xx++) {
        const p = (yy * image.width + xx) * 4
        if (image.data[p + 3] !== 255) return 'alex'
        black &&= image.data[p] === 0 && image.data[p + 1] === 0 && image.data[p + 2] === 0
        white &&= image.data[p] === 255 && image.data[p + 1] === 255 && image.data[p + 2] === 255
      }
    }
  }
  return black || white ? 'alex' : 'steve'
}

// sx, sy, w, h, dx, dy：旧格式右腿/右臂各六面，逐面水平镜像到左侧。
const legacyCopies = [
  [4, 16, 4, 4, 20, 48],
  [8, 16, 4, 4, 24, 48],
  [0, 20, 4, 12, 24, 52],
  [4, 20, 4, 12, 20, 52],
  [8, 20, 4, 12, 16, 52],
  [12, 20, 4, 12, 28, 52],
  [44, 16, 4, 4, 36, 48],
  [48, 16, 4, 4, 40, 48],
  [40, 20, 4, 12, 40, 52],
  [44, 20, 4, 12, 36, 52],
  [48, 20, 4, 12, 32, 52],
  [52, 20, 4, 12, 44, 52],
] as const

function setAlpha(image: Rgba, s: number, x: number, y: number, w: number, h: number, a: number) {
  for (let yy = y * s; yy < (y + h) * s; yy++) {
    for (let xx = x * s; xx < (x + w) * s; xx++) {
      image.data[(yy * image.width + xx) * 4 + 3] = a
    }
  }
}

/** 客户端前处理：补全旧格式、修正 alpha，返回正方形副本并保留透明像素原有的 RGB。 */
export function prepareSkin(image: Rgba): Rgba {
  const s = imageScale(image, 'steve')
  const out = blank(image.width, image.width)
  out.data.set(image.data)
  if (image.height !== image.width) {
    for (const [sx, sy, w, h, dx, dy] of legacyCopies) {
      for (let y = 0; y < h * s; y++) {
        for (let x = 0; x < w * s; x++) {
          const p = ((sy * s + y) * out.width + (sx + w) * s - 1 - x) * 4
          const q = ((dy * s + y) * out.width + dx * s + x) * 4
          for (let c = 0; c < 4; c++) out.data[q + c] = out.data[p + c]!
        }
      }
    }
    let transparent = false
    for (let y = 0; y < 32 * s && !transparent; y++) {
      for (let x = 32 * s; x < 64 * s; x++) {
        if (out.data[(y * out.width + x) * 4 + 3]! < 128) {
          transparent = true
          break
        }
      }
    }
    if (!transparent) setAlpha(out, s, 32, 0, 32, 32, 0)
  }
  setAlpha(out, s, 0, 0, 32, 16, 255)
  setAlpha(out, s, 0, 16, 64, 16, 255)
  setAlpha(out, s, 16, 48, 32, 16, 255)
  return out
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} 必须是正整数`)
}

/** s 的全部约数，升序排列。 */
export function resolutions(s: number): number[] {
  positiveInteger(s, '材质倍数 s')
  const low: number[] = []
  const high: number[] = []
  for (let k = 1; k <= Math.sqrt(s); k++) {
    if (s % k !== 0) continue
    low.push(k)
    if (k !== s / k) high.push(s / k)
  }
  return low.concat(high.reverse())
}

/** 取能整除 displayScale × dpr 的最大材质分辨率，确保浏览器只做整数倍放大。 */
export function pickResolution(s: number, displayScale: number, dpr: number): number {
  positiveInteger(s, '材质倍数 s')
  positiveInteger(displayScale, '显示倍数 displayScale')
  positiveInteger(dpr, '设备像素比 dpr')
  const pixels = displayScale * dpr
  positiveInteger(pixels, '显示倍数与设备像素比的乘积')
  const values = resolutions(s)
  for (let i = values.length - 1; i >= 0; i--) {
    if (pixels % values[i]! === 0) return values[i]!
  }
  return 1
}

function checkResolution(k: number, s?: number): void {
  if (!Number.isSafeInteger(k) || k <= 0 || (s !== undefined && s % k !== 0)) {
    throw new TextureShapeError('分辨率 k 必须是正整数，且必须是材质倍数 s 的约数')
  }
}

/** 正背面拼图尺寸：皮肤 32k×32k，披风 20k×16k。 */
export function figureSize(type: TextureType, k: number): { width: number; height: number } {
  checkResolution(k)
  return type === 'cape' ? { width: 20 * k, height: 16 * k } : { width: 32 * k, height: 32 * k }
}

// 按中心采样一个 UV 矩形；前处理在调用前已完成。每层独立取样与合成后取样等价。
function draw(
  out: Rgba,
  image: Rgba,
  s: number,
  k: number,
  sx: number,
  sy: number,
  w: number,
  h: number,
  dx: number,
  dy: number,
  composite: boolean,
): void {
  const f = s / k
  const center = Math.floor(f / 2)
  for (let y = 0; y < h * k; y++) {
    for (let x = 0; x < w * k; x++) {
      const q = ((sy * s + y * f + center) * image.width + sx * s + x * f + center) * 4
      const p = ((dy * k + y) * out.width + dx * k + x) * 4
      if (composite) over(out.data, p, image.data, q)
      else for (let c = 0; c < 4; c++) out.data[p + c] = image.data[q + c]!
    }
  }
}

/** 正背面拼图；type 决定手臂宽度，渲染不重新推断模型。 */
export function renderFigure(image: Rgba, type: TextureType, k: number): Rgba {
  const s = imageScale(image, type)
  checkResolution(k, s)
  const { width, height } = figureSize(type, k)
  const out = blank(width, height)
  if (type === 'cape') {
    draw(out, image, s, k, 1, 1, 10, 16, 0, 0, false)
    draw(out, image, s, k, 12, 1, 10, 16, 10, 0, false)
    return out
  }
  const skin = prepareSkin(image)
  const a = type === 'alex' ? 3 : 4
  // w, h, d, 模型中心 x/y, 基础 UV, 外层 UV（S4 boxes 的 2D 部分）。
  const parts = [
    [8, 8, 8, 0, 28, 0, 0, 32, 0],
    [8, 12, 4, 0, 18, 16, 16, 16, 32],
    [a, 12, 4, -4 - a / 2, 18, 40, 16, 40, 32],
    [a, 12, 4, 4 + a / 2, 18, 32, 48, 48, 48],
    [4, 12, 4, -2, 6, 0, 16, 0, 32],
    [4, 12, 4, 2, 6, 16, 48, 0, 48],
  ] as const
  for (let view = 0; view < 2; view++) {
    for (const [w, h, d, x, y, u, v, ou, ov] of parts) {
      const dx = view === 0 ? 8 + x - w / 2 : 24 - x - w / 2
      const dy = 32 - y - h / 2
      draw(out, skin, s, k, view === 0 ? u + d : u + w + 2 * d, v + d, w, h, dx, dy, true)
      draw(out, skin, s, k, view === 0 ? ou + d : ou + w + 2 * d, ov + d, w, h, dx, dy, true)
    }
  }
  return out
}

export {
  PngError,
  parsePng,
  decodePngScanlines,
  decodePng,
  normalizeTexture,
  STORED_TEXTURE_LIMITS,
  type PngLimits,
  type ParsedPng,
} from './png.ts'

export { MAX_HEAD_DENSITY, headSize, renderHead } from './head.ts'

export {
  RAISE_FRAMES,
  MAX_POSE_DENSITY,
  poseLayout,
  poseSilhouette,
  poseSize,
  renderPose,
  type PoseLayout,
  type PoseSilhouetteFace,
  type PoseView,
} from './pose.ts'
