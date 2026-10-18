import { readFile } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'
import { renderFigure, renderHead } from '@nextskin/skin'
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
import { decodeTexturePng, encodeTexturePng, pixelHash, processUpload, renderTexture } from './image.ts'

const fixture = () => readFile(new URL('../../../skin/test/fixtures/haka.png', import.meta.url))

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

test('出图结果等于纯 RGBA 渲染器；头像使用 steve', async () => {
  const bytes = await fixture(),
    image = decodeTexturePng(bytes)
  expect(decodeTexturePng(renderTexture({ kind: 'figure', bytes, type: 'alex', k: 1 }))).toEqual(
    renderFigure(image, 'alex', 1),
  )
  expect(decodeTexturePng(renderTexture({ kind: 'head', bytes, type: 'alex', k: 1 }))).toEqual(
    renderHead(image, 'steve', 1),
  )
})
