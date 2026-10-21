import { crc32 } from 'node:zlib'
import type { Rgba } from '@nextskin/skin'
import { expect, test } from 'vitest'
import { decodeTexturePng, encodeTexturePng, pixelHash } from '../textures/image.ts'
import { processSiteImage, SITE_IMAGE_MAX_BYTES } from './image.ts'

function image(
  side: number,
  height = side,
  pixel = (x: number, y: number) => [x * 3, y * 5, (x + y) % 256, 255],
): Rgba {
  const data = new Uint8Array(side * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < side; x++)
      data.set(
        pixel(x, y).map((value) => value % 256),
        (y * side + x) * 4,
      )
  return { width: side, height, data }
}

function chunkTypes(png: Uint8Array): string[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const types: string[] = []
  for (let offset = 8; offset < png.length; offset += 12 + view.getUint32(offset))
    types.push(String.fromCharCode(...png.subarray(offset + 4, offset + 8)))
  return types
}

/** 在 IHDR 后面插一个 tEXt 块 */
function withText(png: Uint8Array): Uint8Array {
  const data = new TextEncoder().encode('Comment\0made by an image editor')
  const chunk = new Uint8Array(data.length + 12)
  const view = new DataView(chunk.buffer)
  view.setUint32(0, data.length)
  chunk.set(new TextEncoder().encode('tEXt'), 4)
  chunk.set(data, 8)
  view.setUint32(data.length + 8, crc32(chunk.subarray(4, -4)))
  return new Uint8Array([...png.subarray(0, 33), ...chunk, ...png.subarray(33)])
}

const error = (bytes: Uint8Array) => {
  try {
    processSiteImage(bytes)
  } catch (thrown) {
    return thrown
  }
  throw new Error('应当抛错')
}

test('重新编码成只有像素的 PNG，存储键是像素 hash', () => {
  const source = image(128)
  const result = processSiteImage(withText(encodeTexturePng(source)))
  expect(chunkTypes(result.png)).toEqual(['IHDR', 'IDAT', 'IEND'])
  expect(decodeTexturePng(result.png)).toEqual(source)
  expect(result.pixelHash).toBe(pixelHash(source))
})

test.each([
  [16, 64],
  [24, 72],
  [32, 64],
  [48, 96],
  [63, 126],
  [64, 64],
])('边长 %i 的图存成 %i：不到 64 的按最近邻放大成整数倍', (side, stored) => {
  const source = image(side)
  const result = decodeTexturePng(processSiteImage(encodeTexturePng(source)).png)
  expect(result.width).toBe(stored)
  expect(result.height).toBe(stored)
  const factor = stored / side
  for (const [x, y] of [
    [0, 0],
    [stored - 1, 0],
    [stored - 1, stored - 1],
    [Math.floor(stored / 2), Math.floor(stored / 3)],
  ]) {
    const at = (y! * stored + x!) * 4
    const from = (Math.floor(y! / factor) * side + Math.floor(x! / factor)) * 4
    expect([...result.data.subarray(at, at + 4)]).toEqual([...source.data.subarray(from, from + 4)])
  }
})

test('白底的那份把半透明和透明的像素铺在白色上', () => {
  const colors = [
    [255, 0, 0, 255],
    [255, 0, 0, 128],
    [0, 0, 0, 0],
    [10, 20, 30, 0],
  ]
  const source = image(64, 64, (x) => colors[x % 4]!)
  const opaque = decodeTexturePng(processSiteImage(encodeTexturePng(source)).opaque)
  expect([...opaque.data.subarray(0, 16)]).toEqual([
    255, 0, 0, 255, 255, 127, 127, 255, 255, 255, 255, 255, 255, 255, 255, 255,
  ])
})

test.each([
  [32, 16],
  [8, 8],
  [600, 600],
  [513, 513],
])('%i×%i 不收，错误带上宽高', (width, height) => {
  const bytes = encodeTexturePng(image(width, height))
  expect(error(bytes)).toMatchObject({ code: 'site_image_size_invalid', params: { width, height } })
})

test('不是 PNG、超过 1 MiB 的不收', () => {
  expect(error(new TextEncoder().encode('GIF89a'))).toMatchObject({ code: 'site_image_file_invalid' })
  const large = new Uint8Array(SITE_IMAGE_MAX_BYTES + 1)
  large.set(encodeTexturePng(image(64)))
  expect(error(large)).toMatchObject({ code: 'site_image_file_invalid' })
})
