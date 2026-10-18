import { readFile, readdir } from 'node:fs/promises'
import { deflateSync, inflateSync } from 'node:zlib'
import { describe, expect, test } from 'vitest'
import { chunk, formats, referenceDecode, samplePng, signature } from '../test/png-corpus.ts'
import { decodePng, decodePngScanlines, normalizeTexture, parsePng, PngError, TextureShapeError } from './index.ts'

function expectSameImage(
  actual: { width: number; height: number; data: Uint8Array },
  expected: { width: number; height: number; data: Uint8Array },
  name: string,
) {
  expect([actual.width, actual.height], name).toEqual([expected.width, expected.height])
  expect(Buffer.from(actual.data).equals(Buffer.from(expected.data)), `${name} 的像素`).toBe(true)
}

const limits = { maxWidth: 1024, maxHeight: 1024, maxInflatedBytes: 9 * 1024 * 1024 }
function decode(bytes: Uint8Array) {
  const parsed = parsePng(bytes, limits)
  return decodePngScanlines(parsed, inflateSync(parsed.idat, { maxOutputLength: parsed.expectedInflatedBytes }))
}

describe('格式语料：独立采样预期 + S4 pngjs 规则', () => {
  for (const [ct, depths] of formats)
    for (const depth of depths)
      for (const interlace of [0, 1]) {
        test(`ct=${ct} depth=${depth} adam7=${interlace}，覆盖 5 种滤波`, async () => {
          const { bytes, expected } = samplePng(ct, depth, interlace)
          expect(decode(bytes)).toEqual(expected)
          expect(decode(bytes)).toEqual(referenceDecode(bytes))
          expect(await decodePng(bytes, limits)).toEqual(expected)
        })
      }
  test('真实皮肤/披风与 pngjs 逐像素一致', async () => {
    const directory = new URL('../test/fixtures/', import.meta.url)
    for (const name of await readdir(directory))
      if (name.endsWith('.png')) {
        const bytes = await readFile(new URL(name, directory))
        // 几十万字节的像素用 toEqual 逐个比较要好几秒，pnpm check 并行跑时会超时；按字节整体比较
        const ours = decode(bytes)
        expectSameImage(ours, referenceDecode(bytes), name)
        expectSameImage(await decodePng(bytes, limits), ours, name)
      }
  })
  test('小尺寸 Adam7 空 pass、行填充位和非 0 字节偏移', () => {
    for (const w of [1, 2, 3, 5])
      for (const h of [1, 2, 3, 5]) {
        const sample = samplePng(0, 1, 1, w, h)
        const padded = Buffer.concat([Buffer.alloc(7), sample.bytes])
        expect(decode(padded.subarray(7))).toEqual(sample.expected)
      }
  })
})

const base = samplePng(6, 8),
  header = chunk('IHDR', base.header),
  idat = chunk('IDAT', base.compressed),
  end = chunk('IEND')
const png = (...parts: Uint8Array[]) => Buffer.concat([signature, ...parts])
const badCrc = Buffer.from(base.bytes)
badCrc[badCrc.length - 1] = badCrc[badCrc.length - 1]! ^ 1
const badHeader = Buffer.from(base.header)
badHeader[8] = 3
const zeroWidth = Buffer.from(base.header)
zeroWidth.writeUInt32BE(0)
const huge = Buffer.from(base.header)
huge.writeUInt32BE(2048)
const badCompression = Buffer.from(base.header)
badCompression[10] = 1
const badInterlace = Buffer.from(base.header)
badInterlace[12] = 2
const indexed = samplePng(3, 1)

test.each([
  ['CRC', badCrc],
  ['截断', base.bytes.subarray(0, -5)],
  ['缺 IEND', base.bytes.subarray(0, -12)],
  ['缺 IDAT', png(header, end)],
  ['重复 IHDR', png(header, header, idat, end)],
  ['未知关键块', png(header, chunk('ABCD'), idat, end)],
  ['IHDR 不在首位', png(idat, header, end)],
  ['IHDR 位深', png(chunk('IHDR', badHeader), idat, end)],
  ['零宽', png(chunk('IHDR', zeroWidth), idat, end)],
  ['宽高上限', png(chunk('IHDR', huge), idat, end)],
  ['压缩方法', png(chunk('IHDR', badCompression), idat, end)],
  ['交错方法', png(chunk('IHDR', badInterlace), idat, end)],
  ['非连续 IDAT', png(header, idat, chunk('tEXt'), idat, end)],
  ['PLTE 在 IDAT 后', png(header, idat, chunk('PLTE', Buffer.alloc(3)), end)],
  ['重复 PLTE', png(header, chunk('PLTE', Buffer.alloc(3)), chunk('PLTE', Buffer.alloc(3)), idat, end)],
  ['PLTE 长度', png(header, chunk('PLTE', Buffer.alloc(4)), idat, end)],
  ['tRNS 在 IDAT 后', png(header, idat, chunk('tRNS', Buffer.alloc(6)), end)],
  ['RGBA 不许 tRNS', png(header, chunk('tRNS', Buffer.alloc(6)), idat, end)],
  ['索引缺 PLTE', png(chunk('IHDR', indexed.header), chunk('IDAT', indexed.compressed), end)],
  [
    '索引 tRNS 在 PLTE 前',
    png(
      chunk('IHDR', indexed.header),
      chunk('tRNS', Buffer.alloc(1)),
      ...indexed.extra,
      chunk('IDAT', indexed.compressed),
      end,
    ),
  ],
  ['块数超限', png(header, ...Array.from({ length: 4096 }, () => chunk('tEXt')), idat, end)],
])('错误输入 %s 抛 PngError', (_, bytes) => {
  expect(() => parsePng(bytes, limits)).toThrow(PngError)
})

test('调色板条目多于位深能表示的个数时照样解析：libpng 和浏览器都放行，BS 导入的旧文件里可能有', () => {
  const bytes = png(
    chunk('IHDR', indexed.header),
    chunk('PLTE', Buffer.alloc(9)),
    chunk('IDAT', indexed.compressed),
    end,
  )
  expect(parsePng(bytes, limits).palette).toHaveLength(9)
})

test('扫描行预算、长度、滤波和调色板索引边界', () => {
  expect(() => parsePng(base.bytes, { ...limits, maxInflatedBytes: 1 })).toThrow(PngError)
  const parsed = parsePng(base.bytes, limits)
  expect(() => decodePngScanlines(parsed, base.raw.subarray(1))).toThrow(PngError)
  const badFilter = Buffer.from(base.raw)
  badFilter[0] = 5
  expect(() => decodePngScanlines(parsed, badFilter)).toThrow(PngError)
  const shortPalette = png(
    chunk('IHDR', indexed.header),
    chunk('PLTE', Buffer.alloc(3)),
    chunk('IDAT', indexed.compressed),
    end,
  )
  expect(() => decode(shortPalette)).toThrow(PngError)
})

test('附加压缩块不解压，连续 IDAT 拼接；IEND 后内容忽略', () => {
  const split = Math.floor(base.compressed.length / 2)
  const bytes = Buffer.concat([
    png(
      header,
      chunk('iCCP', deflateSync(Buffer.alloc(1024 * 1024))),
      chunk('IDAT', base.compressed.subarray(0, split)),
      chunk('IDAT', base.compressed.subarray(split)),
      end,
    ),
    Buffer.from('trailing'),
  ])
  expect(decode(bytes)).toEqual(base.expected)
})

test('Web 解压拒绝炸弹、过短数据、坏 zlib', async () => {
  for (const compressed of [
    deflateSync(Buffer.alloc(16 * 1024 * 1024)),
    deflateSync(Buffer.alloc(1)),
    Buffer.from('invalid'),
  ]) {
    await expect(decodePng(png(header, chunk('IDAT', compressed), end), limits)).rejects.toBeInstanceOf(PngError)
  }
})

test('规范化：保留全部 RGBA、Alex 仅正方形、旧披风左上对齐透明补齐', () => {
  const image = (w: number, h: number) => ({ width: w, height: h, data: new Uint8Array(w * h * 4).fill(73) })
  for (const [type, w, h] of [
    ['steve', 64, 32],
    ['steve', 64, 64],
    ['alex', 128, 128],
    ['cape', 64, 32],
    ['cape', 1024, 512],
  ] as const) {
    const original = image(w, h)
    expect(normalizeTexture(original, type)).toBe(original)
  }
  for (const s of [1, 2, 16]) {
    const input = image(22 * s, 17 * s),
      output = normalizeTexture(input, 'cape')
    expect([output.width, output.height]).toEqual([64 * s, 32 * s])
    const expected = Buffer.alloc(output.data.length)
    for (let y = 0; y < input.height; y++) expected.fill(73, y * output.width * 4, (y * output.width + input.width) * 4)
    expect(Buffer.from(output.data).equals(expected)).toBe(true)
  }
  for (const [type, w, h] of [
    ['alex', 64, 32],
    ['steve', 63, 64],
    ['steve', 64, 48],
    ['cape', 22 * 17, 17 * 17],
    ['steve', 2048, 1024],
  ] as const) {
    expect(() => normalizeTexture(image(w, h), type)).toThrow(TextureShapeError)
  }
  expect(() => normalizeTexture({ ...image(64, 64), data: new Uint8Array(1) }, 'steve')).toThrow(TextureShapeError)
})

test('tRNS 省略时保持 alpha=255；索引 tRNS 未列出的项也为 255', () => {
  for (const ct of [0, 2, 3]) {
    const sample = samplePng(ct, 8),
      extras = ct === 3 ? [sample.extra[0]!] : []
    const bytes = png(chunk('IHDR', sample.header), ...extras, chunk('IDAT', sample.compressed), end)
    const expected = sample.expected.data.slice()
    for (let i = 3; i < expected.length; i += 4) expected[i] = 255
    expect(decode(bytes).data).toEqual(expected)
  }
  const sample = samplePng(3, 2),
    bytes = png(
      chunk('IHDR', sample.header),
      sample.extra[0]!,
      chunk('tRNS', Uint8Array.of(0)),
      chunk('IDAT', sample.compressed),
      end,
    )
  const image = decode(bytes)
  expect(Array.from(image.data.subarray(0, 16))).toEqual([
    17, 35, 51, 0, 200, 70, 33, 255, 0, 255, 64, 255, 255, 0, 128, 255,
  ])
})

test('16 位 tRNS 比较完整采样值，透明与不透明像素的 RGB 都取高字节', () => {
  const header = samplePng(2, 16, 0, 2, 1).header
  const raw = Buffer.from([0, 0, 129, 1, 2, 1, 131, 0, 130, 1, 2, 1, 131])
  const bytes = png(
    chunk('IHDR', header),
    chunk('tRNS', Buffer.from([0, 129, 1, 2, 1, 131])),
    chunk('IDAT', deflateSync(raw)),
    end,
  )
  expect(decode(bytes).data).toEqual(Uint8Array.of(0, 1, 1, 0, 0, 1, 1, 255))
  expect(decode(bytes)).toEqual(referenceDecode(bytes))
})
