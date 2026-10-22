import { readFile } from 'node:fs/promises'
import { deflateSync, inflateSync } from 'node:zlib'
import { parsePng, renderFigure, renderHead, renderPose } from '@nextskin/skin'
import { expect, test } from 'vitest'
import {
  chunk,
  formats,
  referenceEncodePngjs,
  referenceEncodeS4,
  samplePng,
  signature,
} from '../../../skin/test/png-corpus.ts'
import { DomainError } from '../errors.ts'
import {
  decodeTexturePng,
  encodeRenderPng,
  encodeTexturePng,
  inspectTexture,
  pixelHash,
  processUpload,
  renderTexture,
} from './image.ts'
import { POSE_KINDS } from './render-cache.ts'

const fixture = () => readFile(new URL('../../../skin/test/fixtures/haka.png', import.meta.url))
const pngLimits = { maxWidth: 1024, maxHeight: 1024, maxInflatedBytes: 9 * 1024 * 1024 }

test('服务端解码所有格式；固定编码字节与 S4 相同，RGBA 往返不变', () => {
  for (const [ct, depths] of formats)
    for (const depth of depths)
      for (const interlace of [0, 1]) {
        const { bytes, expected } = samplePng(ct, depth, interlace)
        expect(decodeTexturePng(bytes)).toEqual(expected)
        const encoded = encodeTexturePng(expected)
        expect(encoded).toEqual(new Uint8Array(referenceEncodeS4(expected)))
        expect(decodeTexturePng(encoded)).toEqual(expected)
      }
})

test('出图调色板按 RGBA 首次出现排序，tRNS 去掉末尾 255，每行用 None，字节确定', () => {
  const image = {
    width: 3,
    height: 2,
    data: Uint8Array.of(90, 80, 70, 255, 1, 2, 3, 0, 4, 5, 6, 0, 1, 2, 3, 128, 90, 80, 70, 255, 7, 8, 9, 255),
  }
  const bytes = encodeRenderPng(image),
    parsed = parsePng(bytes, pngLimits)
  expect(parsed).toMatchObject({
    depth: 8,
    colorType: 3,
    palette: Uint8Array.of(90, 80, 70, 1, 2, 3, 4, 5, 6, 1, 2, 3, 7, 8, 9),
    transparency: Uint8Array.of(255, 0, 0, 128),
  })
  expect(new Uint8Array(inflateSync(parsed.idat))).toEqual(Uint8Array.of(0, 0, 1, 2, 0, 3, 0, 4))
  expect(encodeRenderPng(image)).toEqual(bytes)
  expect(decodeTexturePng(bytes)).toEqual(image)
})

test.each([1, 256])('不透明的 %d 色出图是 8 位调色板 PNG，不写 tRNS', (count) => {
  const image = { width: count, height: 2, data: new Uint8Array(count * 2 * 4) }
  for (let i = 0; i < count * 2; i++) image.data.set([i % count, 17, 3, 255], i * 4)
  const bytes = encodeRenderPng(image),
    parsed = parsePng(bytes, pngLimits)
  expect(parsed.colorType).toBe(3)
  expect(parsed.depth).toBe(8)
  expect(parsed.palette).toHaveLength(count * 3)
  expect(parsed.transparency).toBeNull()
  expect(decodeTexturePng(bytes)).toEqual(image)
})

test('超过 256 种 RGBA 颜色退回材质编码，完全透明像素的 RGB 也参与计数', () => {
  const image = { width: 257, height: 1, data: new Uint8Array(257 * 4) }
  for (let i = 0; i < 257; i++) image.data.set([i % 256, i >>> 8, 19, 0], i * 4)
  const bytes = encodeRenderPng(image)
  expect(parsePng(bytes, pngLimits).colorType).toBe(6)
  expect(bytes).toEqual(encodeTexturePng(image))
  expect(encodeRenderPng(image)).toEqual(bytes)
  expect(decodeTexturePng(bytes)).toEqual(image)
})

test('编码器字节不同、同像素 hash 相同，透明像素 RGB 参与 hash', async () => {
  const image = decodeTexturePng(await fixture()),
    ours = encodeTexturePng(image),
    pngjs = referenceEncodePngjs(image)
  expect(Buffer.from(ours).equals(Buffer.from(pngjs))).toBe(false)
  expect(pixelHash(decodeTexturePng(ours))).toBe(pixelHash(decodeTexturePng(pngjs)))
  const changed = { ...image, data: image.data.slice() }
  changed.data[0] = changed.data[0]! ^ 1
  expect(pixelHash(changed)).not.toBe(pixelHash(image))
  expect(pixelHash({ ...image, width: image.height, height: image.width })).toBe(pixelHash(image)) // 正方形
  expect(pixelHash({ width: 2, height: 1, data: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8) })).not.toBe(
    pixelHash({ width: 1, height: 2, data: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8) }),
  )
})

test('上传真实皮肤保留像素；披风补边；返回规范化后的尺寸和 hash', async () => {
  const bytes = await fixture(),
    result = processUpload(bytes, 'steve'),
    image = decodeTexturePng(bytes)
  expect(result).toMatchObject({ width: image.width, height: image.height, pixelHash: pixelHash(image) })
  expect(decodeTexturePng(result.png)).toEqual(image)
  const cape = samplePng(6, 8, 0, 44, 34),
    normalized = processUpload(cape.bytes, 'cape')
  expect([normalized.width, normalized.height]).toEqual([128, 64])
  const decoded = decodeTexturePng(normalized.png)
  for (let y = 0; y < 34; y++)
    expect(decoded.data.subarray(y * 128 * 4, (y * 128 + 44) * 4)).toEqual(
      cape.expected.data.subarray(y * 44 * 4, (y + 1) * 44 * 4),
    )
  expect(decoded.data.subarray(34 * 128 * 4).every((v) => v === 0)).toBe(true)
})

test.each([
  ['alex', 64, 32],
  ['steve', 2048, 32],
  ['cape', 22 * 17, 17 * 17],
  ['steve', 63, 64],
] as const)('上传尺寸拒绝 %s %d×%d，带原始宽高', (type, width, height) => {
  expect(() => processUpload(samplePng(6, 8, 0, width, height).bytes, type)).toThrow(
    new DomainError('texture_size_invalid', { width, height }),
  )
  try {
    processUpload(samplePng(6, 8, 0, width, height).bytes, type)
  } catch (error) {
    expect(error).toMatchObject({ code: 'texture_size_invalid', params: { width, height } })
  }
})

test('导入检查与上传的像素 hash、宽高相同，不重新编码；尺寸不合规则的按原图算', async () => {
  const bytes = await fixture()
  const uploaded = processUpload(bytes, 'steve')
  expect(inspectTexture(bytes, 'steve')).toEqual({
    pixelHash: uploaded.pixelHash,
    width: uploaded.width,
    height: uploaded.height,
    conforming: true,
  })
  // 窄披风补宽之后算 hash，与上传一致
  const cape = samplePng(6, 8, 0, 44, 34)
  expect(inspectTexture(cape.bytes, 'cape')).toMatchObject({
    pixelHash: processUpload(cape.bytes, 'cape').pixelHash,
    width: 128,
    height: 64,
    conforming: true,
  })
  // 超过上传的 1024 上限、比例不对的旧文件照样能检查
  for (const [type, width, height] of [
    ['steve', 2048, 1024],
    ['alex', 64, 32],
    ['steve', 100, 37],
  ] as const) {
    const sample = samplePng(6, 8, 0, width, height)
    expect(inspectTexture(sample.bytes, type)).toEqual({
      pixelHash: pixelHash(sample.expected),
      width,
      height,
      conforming: false,
    })
  }
  expect(() => inspectTexture(samplePng(6, 8, 0, 4097, 1).bytes, 'steve')).toThrow(
    new DomainError('texture_file_invalid'),
  )
  expect(() => inspectTexture(Buffer.from('invalid'), 'steve')).toThrow(new DomainError('texture_file_invalid'))
})

test('坏 PNG/解压炸弹映射为 texture_file_invalid', () => {
  const base = samplePng(6, 8, 0, 64, 64)
  const bomb = Buffer.concat([
    signature,
    chunk('IHDR', base.header),
    chunk('IDAT', deflateSync(Buffer.alloc(16 * 1024 * 1024))),
    chunk('IEND'),
  ])
  for (const bytes of [Buffer.from('invalid'), bomb, base.bytes.subarray(0, -7)]) {
    expect(() => processUpload(bytes, 'steve')).toThrow(new DomainError('texture_file_invalid'))
  }
})

test('出图结果等于纯 RGBA 渲染器；头像不看模型', async () => {
  const bytes = await fixture(),
    image = decodeTexturePng(bytes)
  expect(decodeTexturePng(renderTexture({ kind: 'figure', bytes, type: 'alex', k: 1 }))).toEqual(
    renderFigure(image, 'alex', 1),
  )
  expect(decodeTexturePng(renderTexture({ kind: 'head', bytes, type: 'alex', k: 3 }))).toEqual(renderHead(image, 3))
  expect(renderTexture({ kind: 'figure', bytes, type: 'alex', k: 1 })).toEqual(
    encodeRenderPng(renderFigure(image, 'alex', 1)),
  )
  expect(renderTexture({ kind: 'head', bytes, type: 'alex', k: 3 })).toEqual(encodeRenderPng(renderHead(image, 3)))
})

test.each(POSE_KINDS)('%s 按请求模型和密度渲染，用出图编码器保留全部像素', async (kind) => {
  const bytes = await fixture(),
    image = decodeTexturePng(bytes),
    view = kind.startsWith('both') ? 'both' : 'front',
    raise = kind.endsWith('-raise')
  for (const type of ['steve', 'alex'] as const) {
    const expected = renderPose(image, type, view, 2, raise),
      output = renderTexture({ kind, bytes, type, k: 2 })
    expect(output).toEqual(encodeRenderPng(expected))
    expect(decodeTexturePng(output)).toEqual(expected)
  }
  expect(() => renderTexture({ kind, bytes, type: 'cape', k: 2 })).toThrow()
})

test('超过上传上限的导入文件也能出图', () => {
  // 导入的旧文件不受上传的 1024 上限约束（ADR-0031），出图要能解码它们
  const image = { width: 1280, height: 640, data: new Uint8Array(1280 * 640 * 4).map((_, i) => (i * 37) % 251) },
    bytes = encodeTexturePng(image)
  expect(() => processUpload(bytes, 'cape')).toThrow(
    new DomainError('texture_size_invalid', { width: 1280, height: 640 }),
  )
  expect(decodeTexturePng(renderTexture({ kind: 'figure', bytes, type: 'cape', k: 4 }))).toEqual(
    renderFigure(image, 'cape', 4),
  )
})
