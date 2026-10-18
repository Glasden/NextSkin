import { TextureShapeError, textureScale, type Rgba, type TextureType } from './index.ts'

/** 不包含输入内容的 PNG 格式错误；尺寸预算错误附原始尺寸供上传错误映射。 */
export class PngError extends Error {
  override name = 'PngError'
  readonly dimensions?: { width: number; height: number }
  constructor(message: string, dimensions?: { width: number; height: number }) {
    super(message)
    this.dimensions = dimensions
  }
}

export interface PngLimits {
  maxWidth: number
  maxHeight: number
  maxInflatedBytes: number
}

export interface ParsedPng {
  width: number
  height: number
  depth: number
  colorType: number
  interlace: number
  palette: Uint8Array | null
  transparency: Uint8Array | null
  idat: Uint8Array
  expectedInflatedBytes: number
}

const signature = [137, 80, 78, 71, 13, 10, 26, 10]
const channels = [1, 0, 3, 1, 2, 0, 4]
const legalDepths: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
}
const adam7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const
const plain = [[0, 0, 1, 1]] as const
const crcTable = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  let value = i
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  crcTable[i] = value >>> 0
}

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff
  for (let i = start; i < end; i++) crc = crcTable[(crc ^ bytes[i]!) & 255]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** 仅解析必要块，不解压任何附加元数据；尾随 IEND 的字节与 S4 一样忽略。 */
export function parsePng(bytes: Uint8Array, limits: PngLimits): ParsedPng {
  if (bytes.length > 16 * 1024 * 1024) throw new PngError('PNG 输入超过 16 MiB')
  if (bytes.length < 33 || signature.some((v, i) => bytes[i] !== v)) throw new PngError('PNG 签名或头部不完整')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(8) !== 13 || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') {
    throw new PngError('IHDR 必须在首位且长度为 13')
  }
  const width = view.getUint32(16),
    height = view.getUint32(20)
  const depth = bytes[24]!,
    colorType = bytes[25]!,
    interlace = bytes[28]!
  if (
    !width ||
    !height ||
    width > 0x7fffffff ||
    height > 0x7fffffff ||
    !legalDepths[colorType]?.includes(depth) ||
    bytes[26] ||
    bytes[27] ||
    interlace > 1
  ) {
    throw new PngError('IHDR 的尺寸、位深、颜色类型或压缩/滤波/交错方式不合法')
  }
  if (width > limits.maxWidth || height > limits.maxHeight) {
    throw new PngError('PNG 宽高超过上限', { width, height })
  }
  let expectedInflatedBytes = 0
  for (const [x, y, dx, dy] of interlace ? adam7 : plain) {
    const w = Math.max(0, Math.ceil((width - x) / dx))
    const h = Math.max(0, Math.ceil((height - y) / dy))
    if (w && h) expectedInflatedBytes += (Math.ceil((w * channels[colorType]! * depth) / 8) + 1) * h
  }
  if (!Number.isSafeInteger(expectedInflatedBytes) || expectedInflatedBytes > limits.maxInflatedBytes) {
    throw new PngError('PNG 解压预算超限')
  }
  let palette: Uint8Array | null = null,
    transparency: Uint8Array | null = null
  const parts: Uint8Array[] = []
  let idatLength = 0,
    count = 0,
    seenIdat = false,
    endedIdat = false,
    ended = false
  for (let offset = 8; offset < bytes.length;) {
    if (++count > 4096) throw new PngError('PNG 块数超过 4096')
    if (offset + 12 > bytes.length) throw new PngError('PNG 块被截断')
    const length = view.getUint32(offset)
    if (length > bytes.length - offset - 12) throw new PngError('PNG 块被截断')
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type)) throw new PngError('PNG 块类型不合法')
    if (crc32(bytes, offset + 4, offset + 8 + length) !== view.getUint32(offset + 8 + length)) {
      throw new PngError('PNG 块 CRC 不符')
    }
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR' && offset !== 8) throw new PngError('重复 IHDR')
    if (type === 'PLTE') {
      if (
        palette ||
        transparency ||
        seenIdat ||
        !length ||
        length % 3 ||
        length > 768 ||
        colorType === 0 ||
        colorType === 4
      ) {
        throw new PngError('PLTE 的顺序或长度不合法')
      }
      // 不检查条目数是否超过 2^位深：规范不允许，但 libpng 和浏览器都放行，BS 导入的旧文件里可能有
      palette = data
    } else if (type === 'tRNS') {
      if (
        transparency ||
        seenIdat ||
        !(
          (colorType === 0 && length === 2) ||
          (colorType === 2 && length === 6) ||
          (colorType === 3 && palette && length > 0 && length <= palette.length / 3)
        )
      ) {
        throw new PngError('tRNS 的顺序或长度不合法')
      }
      transparency = data
    } else if (type === 'IDAT') {
      if (endedIdat || (colorType === 3 && !palette)) throw new PngError('IDAT 不连续或缺少 PLTE')
      seenIdat = true
      parts.push(data)
      idatLength += length
    } else if (/^[A-Z]/.test(type) && type !== 'IHDR' && type !== 'IEND') {
      throw new PngError('未知 PNG 关键块')
    }
    if (seenIdat && type !== 'IDAT') endedIdat = true
    if (type === 'IEND') {
      if (length) throw new PngError('IEND 长度必须为 0')
      ended = true
      break
    }
    offset += length + 12
  }
  if (!ended || !seenIdat) throw new PngError('缺少 IEND 或 IDAT')
  const idat = new Uint8Array(idatLength)
  let offset = 0
  for (const part of parts) {
    idat.set(part, offset)
    offset += part.length
  }
  return { width, height, depth, colorType, interlace, palette, transparency, idat, expectedInflatedBytes }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c,
    pa = Math.abs(p - a),
    pb = Math.abs(p - b),
    pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

function sample(row: Uint8Array, index: number, depth: number): number {
  if (depth === 16) return row[index * 2]! * 256 + row[index * 2 + 1]!
  if (depth === 8) return row[index]!
  const bit = index * depth
  return (row[bit >>> 3]! >>> (8 - depth - (bit % 8))) & ((1 << depth) - 1)
}
function toByte(value: number, depth: number): number {
  return depth === 16 ? value >>> 8 : depth === 8 ? value : Math.round((value * 255) / ((1 << depth) - 1))
}

/** 两条扫描行复用缓冲区；像素和反滤波的热循环内不分配对象或数组。 */
export function decodePngScanlines(parsed: ParsedPng, inflated: Uint8Array): Rgba {
  if (inflated.length !== parsed.expectedInflatedBytes) throw new PngError('PNG 扫描行长度不符')
  const { width, height, depth, colorType, palette, transparency } = parsed
  const cc = channels[colorType]!,
    bpp = Math.max(1, Math.ceil((cc * depth) / 8))
  const data = new Uint8Array(width * height * 4)
  let offset = 0
  const transView = transparency
    ? new DataView(transparency.buffer, transparency.byteOffset, transparency.length)
    : null
  const tr = transView && colorType !== 3 ? transView.getUint16(0) : -1
  const tg = transView && colorType === 2 ? transView.getUint16(2) : -1
  const tb = transView && colorType === 2 ? transView.getUint16(4) : -1
  for (const [sx, sy, dx, dy] of parsed.interlace ? adam7 : plain) {
    const w = Math.max(0, Math.ceil((width - sx) / dx))
    if (!w || sy >= height) continue
    const stride = Math.ceil((w * cc * depth) / 8)
    let row = new Uint8Array(stride),
      previous = new Uint8Array(stride)
    for (let y = sy; y < height; y += dy) {
      const filter = inflated[offset++]!
      if (filter > 4) throw new PngError('PNG 滤波编号不合法')
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? row[i - bpp]! : 0,
          b = previous[i]!,
          c = i >= bpp ? previous[i - bpp]! : 0
        const prediction =
          filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >>> 1 : paeth(a, b, c)
        row[i] = inflated[offset++]! + prediction
      }
      for (let x = 0; x < w; x++) {
        const p = (y * width + sx + x * dx) * 4,
          i = x * cc
        const r = sample(row, i, depth)
        if (colorType === 3) {
          if (!palette || r * 3 + 2 >= palette.length) throw new PngError('PNG 调色板索引越界')
          data[p] = palette[r * 3]!
          data[p + 1] = palette[r * 3 + 1]!
          data[p + 2] = palette[r * 3 + 2]!
          data[p + 3] = transparency?.[r] ?? 255
        } else {
          const gray = colorType === 0 || colorType === 4
          const g = gray ? r : sample(row, i + 1, depth),
            b = gray ? r : sample(row, i + 2, depth)
          data[p] = toByte(r, depth)
          data[p + 1] = toByte(g, depth)
          data[p + 2] = toByte(b, depth)
          data[p + 3] =
            (colorType === 0 && r === tr) || (colorType === 2 && r === tr && g === tg && b === tb)
              ? 0
              : colorType === 4
                ? toByte(sample(row, i + 1, depth), depth)
                : colorType === 6
                  ? toByte(sample(row, i + 3, depth), depth)
                  : 255
        }
      }
      const swap = previous
      previous = row
      row = swap
    }
  }
  return { width, height, data }
}

/** 浏览器解压路径：边读边核对预算，超过预期立即取消，不经 canvas。 */
export async function decodePng(bytes: Uint8Array, limits: PngLimits): Promise<Rgba> {
  const parsed = parsePng(bytes, limits)
  const stream = new Blob([new Uint8Array(parsed.idat)]).stream().pipeThrough(new DecompressionStream('deflate'))
  const reader = stream.getReader() as ReadableStreamDefaultReader<Uint8Array>
  const inflated = new Uint8Array(parsed.expectedInflatedBytes)
  let length = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (length + value.length > inflated.length) {
        await reader.cancel()
        throw new PngError('PNG 解压数据超过扫描行预算')
      }
      inflated.set(value, length)
      length += value.length
    }
  } catch {
    // 不转发解压器可能包含输入信息的异常。
    throw new PngError('PNG 解压失败或超过扫描行预算')
  } finally {
    reader.releaseLock()
  }
  if (length !== inflated.length) throw new PngError('PNG 扫描行长度不符')
  return decodePngScanlines(parsed, inflated)
}

/** 原始 RGBA 值全部保留；旧披风仅向右、向下补透明像素。 */
export function normalizeTexture(image: Rgba, type: TextureType, maxWidth = 1024): Rgba {
  const { width, height, data } = image
  const s = textureScale(type, width, height)
  if (data.length !== width * height * 4) throw new TextureShapeError('RGBA 像素长度不符')
  if (type === 'alex' && width !== height) throw new TextureShapeError('Alex 皮肤必须是正方形')
  const padded = type === 'cape' && width === 22 * s
  const outputWidth = padded ? 64 * s : width
  if (outputWidth > maxWidth) throw new TextureShapeError('规范化后的宽度超过上限')
  if (!padded) return image
  const output = new Uint8Array(outputWidth * 32 * s * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width * 4; x++) output[y * outputWidth * 4 + x] = data[y * width * 4 + x]!
  }
  return { width: outputWidth, height: 32 * s, data: output }
}
