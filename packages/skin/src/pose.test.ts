import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { describe, expect, it } from 'vitest'
import { blank, paint, patterned, pixel, samePixels } from '../test/helpers.ts'
import {
  MAX_POSE_DENSITY,
  poseLayout,
  poseSilhouette,
  poseSize,
  RAISE_FRAMES,
  renderPose,
  TextureShapeError,
  type PoseView,
  type Rgba,
} from './index.ts'

function fixture(name: string): Rgba {
  const png = PNG.sync.read(readFileSync(new URL(`../test/fixtures/${name}.png`, import.meta.url)))
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) }
}

function frame(image: Rgba, index: number, width: number): Rgba {
  const out = blank(width, image.height)
  for (let y = 0; y < image.height; y++) {
    out.data.set(
      image.data.subarray((y * image.width + index * width) * 4, (y * image.width + (index + 1) * width) * 4),
      y * width * 4,
    )
  }
  return out
}

describe('3D 出图的版式', () => {
  it.each(['both', 'front'] as const)('%s：整数尺寸，站着的方框在帧里', (view) => {
    const { width, height, box } = poseLayout(view)
    for (const value of [width, height, box.x, box.y, box.width, box.height]) expect(Number.isInteger(value)).toBe(true)
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(width)
    expect(box.y + box.height).toBeLessThanOrEqual(height)
  })

  it('正背面并排时左右对称：两边都是抬起的左臂扫过的地方', () => {
    const { width, box } = poseLayout('both')
    expect(width - box.x - box.width).toBe(box.x)
    expect(poseLayout('both').shadows).toHaveLength(2)
    expect(poseLayout('front').shadows).toHaveLength(1)
  })

  it('尺寸按 p 和帧数放大', () => {
    const { width, height } = poseLayout('both')
    expect(poseSize('both', 4, false)).toEqual({ width: width * 4, height: height * 4 })
    expect(poseSize('both', 4, true)).toEqual({ width: width * 4 * RAISE_FRAMES, height: height * 4 })
  })

  it.each([0, -1, 1.5, MAX_POSE_DENSITY + 1, NaN])('p = %s 不合法', (p) => {
    expect(() => poseSize('front', p, false)).toThrow(TextureShapeError)
    expect(() => renderPose(blank(), 'steve', 'front', p, false)).toThrow(TextureShapeError)
  })

  it('材质尺寸不对时拒绝', () => {
    expect(() => renderPose(blank(64, 48), 'steve', 'both', 1, false)).toThrow(TextureShapeError)
  })
})

describe('3D 出图', () => {
  const views: PoseView[] = ['both', 'front']
  it.each(views)('%s：抬手拼图的第 0 帧和静止图逐像素相同，后面几帧都在动', (view) => {
    const image = fixture('hatsune_miku')
    const still = renderPose(image, 'alex', view, 3, false)
    const sheet = renderPose(image, 'alex', view, 3, true)
    expect(samePixels(frame(sheet, 0, still.width), still)).toBe(true)
    for (let i = 1; i < RAISE_FRAMES; i++) {
      expect(samePixels(frame(sheet, i, still.width), frame(sheet, i - 1, still.width))).toBe(false)
    }
  })

  it('内层不透明，外层完全透明的地方露出内层', () => {
    const image = blank()
    paint(image, 0, 0, 64, 64, [200, 100, 50, 0])
    const out = renderPose(image, 'steve', 'front', 2, false)
    const alphas = new Set<number>()
    for (let i = 3; i < out.data.length; i += 4) alphas.add(out.data[i]!)
    expect([...alphas].sort((a, b) => a - b)).toEqual([0, 255])
  })

  it('半透明的外层叠在内层上，结果不透明', () => {
    const image = blank()
    paint(image, 0, 0, 32, 16, [0, 0, 255, 255])
    paint(image, 32, 0, 32, 16, [255, 0, 0, 128])
    const out = renderPose(image, 'steve', 'front', 4, false)
    const { box } = poseLayout('front')
    // 脸的中间：顶上往下五个标准像素、方框中间偏左（正面朝左前方）
    const [r, g, b, a] = pixel(out, (box.x + 7) * 4, (box.y + 6) * 4)
    expect(a).toBe(255)
    expect(r).toBeGreaterThan(0)
    expect(b).toBeGreaterThan(0)
    expect(g).toBe(0)
  })

  it('经典和纤细模型的版式相同，出图不同', () => {
    const image = patterned(64, 64)
    const steve = renderPose(image, 'steve', 'both', 2, false)
    const alex = renderPose(image, 'alex', 'both', 2, false)
    expect([steve.width, steve.height]).toEqual([alex.width, alex.height])
    expect(samePixels(steve, alex)).toBe(false)
  })

  it('高清皮肤按中心取样，p 小于 s 时也能出图', () => {
    const image = fixture('ironman_hd')
    const out = renderPose(image, 'steve', 'both', 3, false)
    expect([out.width, out.height]).toEqual([poseLayout('both').width * 3, poseLayout('both').height * 3])
    expect(out.data.some((value, i) => i % 4 === 3 && value === 255)).toBe(true)
  })

  it('剪影的面都落在帧里，从远到近排好', () => {
    for (const view of views) {
      const { width, height } = poseLayout(view)
      const faces = poseSilhouette(view)
      expect(faces.length).toBeGreaterThan(0)
      for (const { points, shade } of faces) {
        expect(points).toHaveLength(8)
        points.forEach((value, i) => {
          expect(value).toBeGreaterThanOrEqual(-1e-9)
          expect(value).toBeLessThanOrEqual((i % 2 ? height : width) + 1e-9)
        })
        expect(shade).toBeGreaterThan(0)
        expect(shade).toBeLessThanOrEqual(1)
      }
    }
  })
})
