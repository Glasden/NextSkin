import { describe, expect, it } from 'vitest'
import { blank, paint, patterned, pixel, samePixels } from '../test/helpers.ts'
import { headSize, MAX_HEAD_DENSITY, renderHead, TextureShapeError, type Rgba } from './index.ts'

const FACE = [10, 20, 30, 255]

// 每个标准像素放大成 s×s 的同色块
function upscale(image: Rgba, s: number): Rgba {
  const out = blank(image.width * s, image.height * s)
  for (let y = 0; y < out.height; y++)
    for (let x = 0; x < out.width; x++) {
      const q = (Math.floor(y / s) * image.width + Math.floor(x / s)) * 4
      out.data.set(image.data.subarray(q, q + 4), (y * out.width + x) * 4)
    }
  return out
}

describe('头像', () => {
  it.each([
    [2, 1, 17],
    [3, 1, 25],
    [4, 2, 34],
    [6, 3, 51],
  ])('p=%i：9p×9p，脸占 [%i, %i)，外面一圈是帽子', (p, from, to) => {
    const skin = blank()
    paint(skin, 8, 8, 8, 8, FACE)
    const head = renderHead(skin, p)
    expect([head.width, head.height]).toEqual([9 * p, 9 * p])
    for (let y = 0; y < head.height; y++)
      for (let x = 0; x < head.width; x++) {
        const face = x >= from && x < to && y >= from && y < to
        expect(pixel(head, x, y)).toEqual(face ? FACE : [0, 0, 0, 0])
      }
  })

  it('帽子正面盖在脸上，一格是 9p/8 个像素', () => {
    const skin = blank()
    paint(skin, 8, 8, 8, 8, FACE)
    for (let u = 0; u < 8; u++) paint(skin, 40 + u, 8, 1, 8, [u * 30, 100, 200, 255])
    // p = 8 时帽子的一格正好是 9 个像素
    const head = renderHead(skin, 8)
    for (let y = 0; y < head.height; y++)
      for (let x = 0; x < head.width; x++) expect(pixel(head, x, y)).toEqual([Math.floor(x / 9) * 30, 100, 200, 255])
  })

  it('帽子正面透明的地方露出帽子背面的内侧，左右镜像；脸上看不到它', () => {
    const skin = blank()
    paint(skin, 8, 8, 8, 8, FACE)
    paint(skin, 56, 8, 1, 8, [200, 0, 0, 255])
    paint(skin, 63, 8, 1, 8, [0, 200, 0, 255])
    const head = renderHead(skin, 8)
    // 脸从 4 到 68；帽子背面最右一列在画面左边
    for (const x of [0, 3]) expect(pixel(head, x, 36)).toEqual([0, 200, 0, 255])
    for (const x of [68, 71]) expect(pixel(head, x, 36)).toEqual([200, 0, 0, 255])
    for (const x of [4, 67]) expect(pixel(head, x, 36)).toEqual(FACE)
    expect(pixel(head, 36, 0)).toEqual([0, 0, 0, 0])
  })

  it('半透明的帽子用 float32 over 叠在脸和帽子背面上，输入不变', () => {
    const skin = blank()
    paint(skin, 8, 8, 8, 8, [100, 150, 200, 0])
    paint(skin, 40, 8, 8, 8, [200, 50, 100, 128])
    paint(skin, 56, 8, 8, 8, [100, 150, 200, 255])
    const before = skin.data.slice()
    const head = renderHead(skin, 2)
    // 脸的基础层强制不透明，和帽子背面同色，叠出来的颜色相同
    expect(pixel(head, 9, 9)).toEqual([150, 99, 149, 255])
    expect(pixel(head, 0, 0)).toEqual([150, 99, 149, 255])
    expect(skin.data).toEqual(before)
  })

  it('旧版皮肤的帽子区域完全不透明时忽略帽子', () => {
    const skin = blank(64, 32)
    paint(skin, 0, 0, 64, 32, [70, 80, 90, 255])
    paint(skin, 8, 8, 8, 8, FACE)
    const head = renderHead(skin, 2)
    expect(pixel(head, 0, 0)).toEqual([0, 0, 0, 0])
    expect(pixel(head, 9, 9)).toEqual(FACE)
  })

  it.each([2, 4, 8])('s=%i：每个标准像素是同色块时，出图和普通皮肤相同', (s) => {
    for (const height of [64, 32]) {
      const skin = patterned(64, height),
        hd = upscale(skin, s)
      for (let p = 1; p <= MAX_HEAD_DENSITY; p++) expect(samePixels(renderHead(hd, p), renderHead(skin, p))).toBe(true)
    }
  })

  it.each([0, -1, 1.5, NaN, Infinity, MAX_HEAD_DENSITY + 1])('拒绝 p=%s', (p) => {
    expect(() => headSize(p)).toThrow(TextureShapeError)
    expect(() => renderHead(blank(), p)).toThrow(TextureShapeError)
  })

  it('拒绝不合法的皮肤尺寸', () => {
    expect(() => renderHead(blank(64, 48), 2)).toThrow(TextureShapeError)
  })
})
