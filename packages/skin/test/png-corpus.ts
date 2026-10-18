import { crc32, deflateSync } from 'node:zlib'
import { PNG } from 'pngjs'
import type { Rgba } from '../src/index.ts'

export const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
export function chunk(type: string, data: Uint8Array = new Uint8Array()): Buffer {
  const out = Buffer.alloc(data.length + 12)
  out.writeUInt32BE(data.length)
  out.write(type, 4)
  out.set(data, 8)
  out.writeUInt32BE(crc32(out.subarray(4, -4)), out.length - 4)
  return out
}
const adam7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
]
export const formats = [
  [0, [1, 2, 4, 8, 16]],
  [2, [8, 16]],
  [3, [1, 2, 4, 8]],
  [4, [8, 16]],
  [6, [8, 16]],
] as const

/** 独立构造原始采样和滤波扫描行；不调用被测解析器/解码器。 */
export function samplePng(colorType: number, depth: number, interlace = 0, width = 19, height = 13) {
  const cc = [1, 0, 3, 1, 2, 0, 4][colorType]!,
    max = 2 ** depth - 1
  const palette = [
    [17, 35, 51, 0],
    [200, 70, 33, 127],
    [0, 255, 64, 255],
    [255, 0, 128, 255],
  ].slice(0, Math.min(2 ** depth, 4))
  const values = (x: number, y: number) =>
    colorType === 3
      ? [(x + y) % palette.length]
      : Array.from({ length: cc }, (_, c) => (x * 257 + y * 515 + c * 129 + 129) % (max + 1))
  const rows: Buffer[] = []
  const passes = interlace ? adam7 : [[0, 0, 1, 1]]
  for (const [sx, sy, dx, dy] of passes) {
    const w = Math.max(0, Math.ceil((width - sx!) / dx!))
    if (!w) continue
    let previous = Buffer.alloc(Math.ceil((w * cc * depth) / 8)),
      rowNumber = 0
    for (let y = sy!; y < height; y += dy!) {
      const row = Buffer.alloc(previous.length)
      let bit = 0
      for (let x = sx!; x < width; x += dx!)
        for (const v of values(x, y)) {
          if (depth === 16) row.writeUInt16BE(v, bit >>> 3)
          else if (depth === 8) row[bit >>> 3] = v
          else row[bit >>> 3] = row[bit >>> 3]! | (v << (8 - depth - (bit % 8)))
          bit += depth
        }
      const filter = rowNumber++ % 5,
        bpp = Math.max(1, Math.ceil((cc * depth) / 8))
      const filtered = Buffer.alloc(row.length + 1)
      filtered[0] = filter
      for (let i = 0; i < row.length; i++) {
        const a = i >= bpp ? row[i - bpp]! : 0,
          b = previous[i]!,
          c = i >= bpp ? previous[i - bpp]! : 0
        const p = a + b - c,
          pa = Math.abs(p - a),
          pb = Math.abs(p - b),
          pc = Math.abs(p - c)
        const prediction = [0, a, b, Math.floor((a + b) / 2), pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter]!
        filtered[i + 1] = (row[i]! - prediction) & 255
      }
      rows.push(filtered)
      previous = row
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = depth
  header[9] = colorType
  header[12] = interlace
  const extra: Buffer[] = [],
    transparent = values(0, 0)
  if (colorType === 3)
    extra.push(
      chunk('PLTE', Buffer.from(palette.flatMap((p) => p.slice(0, 3)))),
      chunk('tRNS', Buffer.from(palette.map((p) => p[3]!))),
    )
  if (colorType === 0 || colorType === 2) {
    const t = Buffer.alloc(cc * 2)
    transparent.forEach((v, i) => t.writeUInt16BE(v, i * 2))
    extra.push(chunk('tRNS', t))
  }
  const raw = Buffer.concat(rows),
    compressed = deflateSync(raw)
  const bytes = Buffer.concat([signature, chunk('IHDR', header), ...extra, chunk('IDAT', compressed), chunk('IEND')])
  const data = new Uint8Array(width * height * 4),
    convert = (v: number) => (depth === 16 ? v >>> 8 : Math.round((v * 255) / max))
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const v = values(x, y),
        p = (y * width + x) * 4
      if (colorType === 3) {
        data.set(palette[v[0]!]!, p)
        continue
      }
      const gray = colorType === 0 || colorType === 4
      const rgb = gray ? [v[0]!, v[0]!, v[0]!] : v.slice(0, 3)
      const transparentPixel = (colorType === 0 || colorType === 2) && v.every((n, c) => n === transparent[c])
      data.set(
        [
          ...rgb.map(convert),
          transparentPixel ? 0 : colorType === 4 ? convert(v[1]!) : colorType === 6 ? convert(v[3]!) : 255,
        ],
        p,
      )
    }
  return { bytes, expected: { width, height, data } satisfies Rgba, header, extra, raw, compressed }
}

/** ADR-0008 / S4 的 pngjs 路径：移除灰度/RGB tRNS 后自行设 alpha；16 位取高字节。 */
export function referenceDecode(input: Uint8Array): Rgba {
  const bytes = Buffer.from(input),
    parts: Buffer[] = [],
    depth = bytes[24]!,
    colorType = bytes[25]!
  let trns: Buffer | undefined
  for (let p = 8; p < bytes.length;) {
    const n = bytes.readUInt32BE(p),
      type = bytes.toString('ascii', p + 4, p + 8)
    if (type === 'tRNS') trns = bytes.subarray(p + 8, p + 8 + n)
    if (type !== 'tRNS' || (colorType !== 0 && colorType !== 2)) parts.push(bytes.subarray(p, p + n + 12))
    p += n + 12
    if (type === 'IEND') break
  }
  const decoded = PNG.sync.read(Buffer.concat([signature, ...parts]), { skipRescale: true })
  const data = new Uint8Array(decoded.width * decoded.height * 4)
  for (let i = 0; i < data.length; i++) {
    data[i] =
      depth === 16
        ? decoded.data[i]! >>> 8
        : colorType === 3
          ? decoded.data[i]!
          : Math.round((decoded.data[i]! * 255) / ((1 << depth) - 1))
  }
  if (trns && (colorType === 0 || colorType === 2))
    for (let i = 0; i < data.length; i += 4) {
      if (
        decoded.data[i] === trns.readUInt16BE(0) &&
        (colorType === 0 ||
          (decoded.data[i + 1] === trns.readUInt16BE(2) && decoded.data[i + 2] === trns.readUInt16BE(4)))
      )
        data[i + 3] = 0
    }
  return { width: decoded.width, height: decoded.height, data }
}

export function referenceEncodePngjs(image: Rgba): Uint8Array {
  return PNG.sync.write(
    Object.assign(new PNG({ width: image.width, height: image.height }), { data: Buffer.from(image.data) }),
    {
      deflateLevel: 6,
      colorType: 6,
      inputColorType: 6,
    },
  )
}

/** 保留 S4 encodePng 的独立写法，守护滤波评分、同分规则和压缩参数。 */
export function referenceEncodeS4(image: Rgba): Uint8Array {
  const { width: w, height: h, data } = image,
    stride = w * 4,
    raw = Buffer.alloc((stride + 1) * h)
  const candidates = Array.from({ length: 5 }, () => new Uint8Array(stride))
  for (let y = 0; y < h; y++) {
    const scores = [0, 0, 0, 0, 0]
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x,
        v = data[i]!,
        a = x >= 4 ? data[i - 4]! : 0,
        b = y ? data[i - stride]! : 0,
        c = y && x >= 4 ? data[i - stride - 4]! : 0
      const p = a + b - c,
        pa = Math.abs(p - a),
        pb = Math.abs(p - b),
        pc = Math.abs(p - c)
      const predictions = [0, a, b, (a + b) >>> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c]
      for (let f = 0; f < 5; f++) {
        const d = (v - predictions[f]!) & 255
        candidates[f]![x] = d
        scores[f] = scores[f]! + Math.min(d, 256 - d)
      }
    }
    const f = scores.indexOf(Math.min(...scores))
    raw[y * (stride + 1)] = f
    raw.set(candidates[f]!, y * (stride + 1) + 1)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(w)
  header.writeUInt32BE(h, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND')])
}
