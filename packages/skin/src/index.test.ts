import { describe, expect, it } from 'vitest'
import { blank, paint, patterned, pixel, samePixels } from '../test/helpers.ts'
import {
  figureSize,
  inferSkinModel,
  pickResolution,
  prepareSkin,
  renderFigure,
  renderHead,
  resolutions,
  textureScale,
  TextureShapeError,
  type Rgba,
} from './index.ts'

describe('材质形状', () => {
  it.each([
    ['steve', 64, 64, 1],
    ['alex', 128, 128, 2],
    ['steve', 512, 256, 8],
    ['cape', 64, 32, 1],
    ['cape', 128, 64, 2],
    ['cape', 22, 17, 1],
    ['cape', 66, 51, 3],
    ['steve', 1088, 544, 17],
  ] as const)('%s %i×%i → %i', (type, w, h, s) => expect(textureScale(type, w, h)).toBe(s))

  it.each([
    ['steve', 0, 0],
    ['alex', 64, 32.5],
    ['steve', 65, 64],
    ['steve', 64, 16],
    ['cape', 22, 16],
    ['cape', 44, 17],
    ['cape', 64, 64],
    ['cape', 128, 32],
    ['steve', -64, -64],
    ['cape', Infinity, 32],
    ['alex', NaN, 64],
  ] as const)('拒绝 %s %i×%i', (type, w, h) => expect(() => textureScale(type, w, h)).toThrow(TextureShapeError))

  it('检查 RGBA 长度', () => {
    const bad = { width: 64, height: 64, data: new Uint8Array(4) }
    for (const run of [
      () => inferSkinModel(bad),
      () => prepareSkin(bad),
      () => renderFigure(bad, 'steve', 1),
      () => renderHead(bad, 'alex', 1),
    ]) {
      expect(run).toThrow('RGBA 像素长度')
    }
  })
})

const gaps = [
  [50, 16, 2, 4],
  [54, 20, 2, 12],
  [42, 48, 2, 4],
  [46, 52, 2, 12],
] as const

describe('模型推断在前处理前运行', () => {
  it.each([1, 2])('s=%i 的透明、黑、白手臂区域', (s) => {
    for (const color of [
      [0, 0, 0, 255],
      [255, 255, 255, 255],
    ]) {
      const skin = blank(64 * s)
      paint(skin, 0, 0, skin.width, skin.height, [70, 80, 90, 255])
      for (const [x, y, w, h] of gaps) paint(skin, x * s, y * s, w * s, h * s, color)
      expect(inferSkinModel(skin)).toBe('alex')
    }
    // 四个区域中任一个像素的 alpha 非 255 都足够，RGB 不参与该分支。
    for (const [x, y, w, h] of gaps) {
      const skin = blank(64 * s)
      paint(skin, 0, 0, skin.width, skin.height, [70, 80, 90, 255])
      expect(inferSkinModel(skin)).toBe('steve')
      paint(skin, (x + w) * s - 1, (y + h) * s - 1, 1, 1, [12, 34, 56, 254])
      expect(inferSkinModel(skin)).toBe('alex')
    }
    expect(inferSkinModel(blank(64 * s, 32 * s))).toBe('steve')
  })

  it('混合黑白不等于全黑或全白', () => {
    const skin = blank()
    paint(skin, 0, 0, 64, 64, [0, 0, 0, 255])
    paint(skin, 50, 16, 1, 1, [255, 255, 255, 255])
    expect(inferSkinModel(skin)).toBe('steve')
  })
})

describe('客户端前处理', () => {
  it.each([1, 2])('s=%i：旧格式十二个面逐面镜像补全', (s) => {
    const source = patterned(64 * s, 32 * s)
    const out = prepareSkin(source)
    const copies = [
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
    for (const [sx, sy, w, h, dx, dy] of copies) {
      for (let y = 0; y < h * s; y++) {
        for (let x = 0; x < w * s; x++) {
          expect(pixel(out, dx * s + x, dy * s + y)).toEqual([
            ...pixel(source, (sx + w) * s - 1 - x, sy * s + y).slice(0, 3),
            255,
          ])
        }
      }
    }
    expect([out.width, out.height]).toEqual([64 * s, 64 * s])
    expect(pixel(out, 0, 40 * s)).toEqual([0, 0, 0, 0])
  })

  it.each([127, 128, 255])('旧帽子层阈值 %i，随后恢复下半块基础层', (alpha) => {
    const source = blank(64, 32)
    paint(source, 0, 0, 64, 32, [12, 34, 56, 255])
    paint(source, 63, 31, 1, 1, [90, 80, 70, alpha])
    const out = prepareSkin(source)
    expect(pixel(out, 40, 8)).toEqual([12, 34, 56, alpha < 128 ? 255 : 0])
    expect(pixel(out, 63, 31)).toEqual([90, 80, 70, 255])
  })

  it('所有基础区域强制不透明，透明 RGB 和输入原样保留，新格式帽子不被清除', () => {
    const source = blank()
    paint(source, 0, 0, 64, 64, [19, 27, 35, 0])
    const before = source.data.slice()
    const out = prepareSkin(source)
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const base = (x < 32 && y < 16) || (y >= 16 && y < 32) || (x >= 16 && x < 48 && y >= 48)
        expect(pixel(out, x, y)).toEqual([19, 27, 35, base ? 255 : 0])
      }
    }
    expect(source.data).toEqual(before)
    expect(out.data).not.toBe(source.data)
    paint(source, 32, 0, 32, 16, [11, 22, 33, 255])
    expect(pixel(prepareSkin(source), 40, 8)).toEqual([11, 22, 33, 255])
  })
})

// 独立声明各正背面 UV 与期望位置；逐像素检查整个画布，包括身体外的透明区域。
function markedSkin(alex: boolean): { skin: Rgba; expected: Rgba } {
  const skin = blank()
  const expected = blank(32)
  const a = alex ? 3 : 4
  const faces = [
    [8, 8, 8, 8, 4, 0],
    [24, 8, 8, 8, 20, 0],
    [20, 20, 8, 12, 4, 8],
    [32, 20, 8, 12, 20, 8],
    [44, 20, a, 12, 4 - a, 8],
    [48 + a, 20, a, 12, 28, 8],
    [36, 52, a, 12, 12, 8],
    [40 + a, 52, a, 12, 20 - a, 8],
    [4, 20, 4, 12, 4, 20],
    [12, 20, 4, 12, 24, 20],
    [20, 52, 4, 12, 8, 20],
    [28, 52, 4, 12, 20, 20],
  ] as const
  faces.forEach(([sx, sy, w, h, dx, dy], i) => {
    const color = [20 + i * 15, 230 - i * 10, 40 + i * 12, 255]
    paint(skin, sx, sy, w, h, color)
    paint(expected, dx, dy, w, h, color)
  })
  return { skin, expected }
}

function centerResize(image: Rgba, f: number): Rgba {
  const out = blank(image.width / f, image.height / f)
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      out.data.set(pixel(image, x * f + Math.floor(f / 2), y * f + Math.floor(f / 2)), (y * out.width + x) * 4)
    }
  }
  return out
}

describe('2D 正背面与头像', () => {
  it.each([false, true])('所有身体部位的正背面位置，alex=%s', (alex) => {
    const { skin, expected } = markedSkin(alex)
    const before = skin.data.slice()
    expect(samePixels(renderFigure(skin, alex ? 'alex' : 'steve', 1), expected)).toBe(true)
    expect(skin.data).toEqual(before)
  })

  it('alex 手臂宽 3，最外侧一列透明；type 决定模型', () => {
    const skin = blank()
    paint(skin, 0, 0, 64, 64, [60, 120, 180, 255])
    const out = renderFigure(skin, 'alex', 1)
    for (const x of [0, 15, 16, 31]) expect(pixel(out, x, 10)).toEqual([0, 0, 0, 0])
    for (const x of [1, 14, 17, 30]) expect(pixel(out, x, 10)[3]).toBe(255)
    expect(pixel(renderFigure(skin, 'steve', 1), 0, 10)[3]).toBe(255)
  })

  it('半透明外层用 float32 over 合成；头像与正脸一致且输入不变', () => {
    const skin = blank()
    paint(skin, 8, 8, 8, 8, [100, 150, 200, 0])
    paint(skin, 40, 8, 8, 8, [200, 50, 100, 128])
    const before = skin.data.slice()
    expect(pixel(renderFigure(skin, 'steve', 1), 4, 0)).toEqual([150, 99, 149, 255])
    for (const type of ['steve', 'alex'] as const) {
      const head = renderHead(skin, type, 1)
      expect([head.width, head.height]).toEqual([8, 8])
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) expect(pixel(head, x, y)).toEqual([150, 99, 149, 255])
    }
    expect(skin.data).toEqual(before)
  })

  it('旧帽子层阈值在原分辨率检查，不能先缩小再前处理', () => {
    const skin = blank(128, 64)
    paint(skin, 0, 0, 128, 64, [100, 120, 140, 255])
    paint(skin, 80, 16, 16, 16, [200, 220, 240, 255])
    // 缩小不会选中的一个透明像素，仍应阻止整块帽子清 alpha。
    paint(skin, 64, 0, 1, 1, [0, 0, 0, 127])
    expect(pixel(renderHead(skin, 'steve', 1), 0, 0)).toEqual([200, 220, 240, 255])
  })

  it.each([3, 4])('s=%i 的所有 k 按 f×f 方块中心取样', (s) => {
    for (const height of [64 * s, 32 * s]) {
      const skin = patterned(64 * s, height)
      for (const type of ['steve', 'alex'] as const) {
        const full = renderFigure(skin, type, s)
        const head = renderHead(skin, type, s)
        for (const k of resolutions(s)) {
          expect(samePixels(renderFigure(skin, type, k), centerResize(full, s / k))).toBe(true)
          expect(samePixels(renderHead(skin, type, k), centerResize(head, s / k))).toBe(true)
        }
      }
    }
  })

  it.each([
    [64, 32],
    [22, 17],
    [128, 64],
    [44, 34],
  ] as const)('披风 %i×%i 的正背面和透明 RGB', (w, h) => {
    const cape = blank(w, h)
    const before = cape.data.slice()
    const s = textureScale('cape', w, h)
    paint(cape, s, s, 10 * s, 16 * s, [45, 90, 135, 128])
    paint(cape, 12 * s, s, 10 * s, 16 * s, [1, 2, 3, 0])
    const painted = cape.data.slice()
    for (const k of resolutions(s)) {
      const out = renderFigure(cape, 'cape', k)
      expect([out.width, out.height]).toEqual([20 * k, 16 * k])
      for (let y = 0; y < out.height; y++)
        for (let x = 0; x < out.width; x++) {
          expect(pixel(out, x, y)).toEqual(x < 10 * k ? [45, 90, 135, 128] : [1, 2, 3, 0])
        }
    }
    expect(cape.data).toEqual(painted)
    expect(cape.data).not.toEqual(before)
    const patternedCape = patterned(w, h)
    expect(
      samePixels(renderFigure(patternedCape, 'cape', 1), centerResize(renderFigure(patternedCape, 'cape', s), s)),
    ).toBe(true)
  })

  it.each([0, -1, 1.5, NaN, Infinity, 3, 8])('s=4 拒绝 k=%s', (k) => {
    expect(() => renderFigure(blank(256), 'steve', k)).toThrow(TextureShapeError)
    expect(() => renderFigure(blank(256, 128), 'cape', k)).toThrow(TextureShapeError)
    expect(() => renderHead(blank(256), 'alex', k)).toThrow(TextureShapeError)
  })

  it('拼图尺寸与 k 校验', () => {
    expect(figureSize('steve', 2)).toEqual({ width: 64, height: 64 })
    expect(figureSize('alex', 3)).toEqual({ width: 96, height: 96 })
    expect(figureSize('cape', 2)).toEqual({ width: 40, height: 32 })
    for (const k of [0, -1, 0.5, NaN, Infinity]) expect(() => figureSize('steve', k)).toThrow(TextureShapeError)
  })
})

describe('页面分辨率选择', () => {
  it('全部约数升序，无重复', () => {
    expect(resolutions(1)).toEqual([1])
    expect(resolutions(8)).toEqual([1, 2, 4, 8])
    expect(resolutions(36)).toEqual([1, 2, 3, 4, 6, 9, 12, 18, 36])
    expect(resolutions(7)).toEqual([1, 7])
  })

  it('选择能整除显示像素的最大约数', () => {
    expect(pickResolution(8, 4, 2)).toBe(8)
    expect(pickResolution(8, 5, 1)).toBe(1)
    expect(pickResolution(8, 5, 2)).toBe(2)
    for (const scale of [1, 4, 5, 8]) for (const dpr of [1, 2]) expect(pickResolution(1, scale, dpr)).toBe(1)
  })

  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('非正整数 %s 抛 RangeError', (bad) => {
    expect(() => resolutions(bad)).toThrow(RangeError)
    expect(() => pickResolution(bad, 4, 2)).toThrow(RangeError)
    expect(() => pickResolution(8, bad, 2)).toThrow(RangeError)
    expect(() => pickResolution(8, 4, bad)).toThrow(RangeError)
  })
})
