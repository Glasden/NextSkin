import { createHash } from 'node:crypto'
import { crc32, deflateSync, inflateSync } from 'node:zlib'
import {
  PngError,
  TextureShapeError,
  parsePng,
  decodePngScanlines,
  normalizeTexture,
  renderFigure,
  renderHead,
  type Rgba,
  type TextureType,
  type PngLimits,
} from '@nextskin/skin'
import { DomainError } from '../errors.ts'

const limits: PngLimits = { maxWidth: 1024, maxHeight: 1024, maxInflatedBytes: 9 * 1024 * 1024 }
const signature = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)

export function decodeTexturePng(bytes: Uint8Array, budget: PngLimits = limits): Rgba {
  const parsed = parsePng(bytes, budget)
  let inflated: Uint8Array
  try {
    inflated = inflateSync(parsed.idat, { maxOutputLength: parsed.expectedInflatedBytes })
  } catch {
    throw new PngError('PNG 解压失败或超过扫描行预算')
  }
  return decodePngScanlines(parsed, inflated)
}

function chunk(type: string, data = new Uint8Array()): Uint8Array {
  const bytes = new Uint8Array(data.length + 12)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) bytes[i + 4] = type.charCodeAt(i)
  bytes.set(data, 8)
  view.setUint32(data.length + 8, crc32(bytes.subarray(4, -4)))
  return bytes
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c,
    pa = Math.abs(p - a),
    pb = Math.abs(p - b),
    pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** S4 固定编码：绝对残差和最小者优先，同分选小编号；zlib level 6。 */
export function encodeTexturePng(image: Rgba): Uint8Array {
  const { width, height, data } = image
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    data.length !== width * height * 4
  ) {
    throw new TextureShapeError('RGBA 尺寸或像素长度不合法')
  }
  const stride = width * 4,
    raw = new Uint8Array((stride + 1) * height)
  const candidates = Array.from({ length: 5 }, () => new Uint8Array(stride))
  const scores = new Float64Array(5),
    predictions = new Uint8Array(5)
  for (let y = 0; y < height; y++) {
    scores.fill(0)
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x,
        v = data[i]!,
        a = x >= 4 ? data[i - 4]! : 0
      const b = y ? data[i - stride]! : 0,
        c = y && x >= 4 ? data[i - stride - 4]! : 0
      predictions[1] = a
      predictions[2] = b
      predictions[3] = (a + b) >>> 1
      predictions[4] = paeth(a, b, c)
      for (let f = 0; f < 5; f++) {
        const d = (v - predictions[f]!) & 255
        candidates[f]![x] = d
        scores[f] = scores[f]! + Math.min(d, 256 - d)
      }
    }
    let filter = 0
    for (let f = 1; f < 5; f++) if (scores[f]! < scores[filter]!) filter = f
    raw[y * (stride + 1)] = filter
    raw.set(candidates[filter]!, y * (stride + 1) + 1)
  }
  const ihdr = new Uint8Array(13),
    view = new DataView(ihdr.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  ihdr[8] = 8
  ihdr[9] = 6
  const parts = [
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 6 }))),
    chunk('IEND'),
  ]
  const output = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

export function pixelHash(image: Rgba): string {
  const dimensions = new Uint8Array(8),
    view = new DataView(dimensions.buffer)
  view.setUint32(0, image.width)
  view.setUint32(4, image.height)
  return createHash('sha256').update(dimensions).update(image.data).digest('hex')
}

export interface UploadImage {
  png: Uint8Array
  pixelHash: string
  width: number
  height: number
}
export function processUpload(bytes: Uint8Array, type: TextureType): UploadImage {
  let image: Rgba
  try {
    image = decodeTexturePng(bytes)
  } catch (error) {
    if (error instanceof PngError && error.dimensions) throw new DomainError('texture_size_invalid', error.dimensions)
    throw new DomainError('texture_file_invalid')
  }
  let normalized: Rgba
  try {
    normalized = normalizeTexture(image, type)
  } catch (error) {
    if (!(error instanceof TextureShapeError)) throw error
    throw new DomainError('texture_size_invalid', { width: image.width, height: image.height })
  }
  return {
    png: encodeTexturePng(normalized),
    pixelHash: pixelHash(normalized),
    width: normalized.width,
    height: normalized.height,
  }
}

// 导入的旧文件不受上传的尺寸上限约束（尺寸不合规则的照样导入），但解码的内存仍要有上限：4096×4096 的 RGBA 是 64 MiB
const importLimits: PngLimits = { maxWidth: 4096, maxHeight: 4096, maxInflatedBytes: 4096 * (4096 * 4 + 1) }

export interface InspectedImage {
  pixelHash: string
  width: number
  height: number
  /** 能按上传的规则规范化；false 时像素 hash 和宽高按解码出的原图算 */
  conforming: boolean
}
/**
 * 导入旧文件（ADR-0031）：按上传的规则解码、规范化后算像素 hash 和宽高，上传查重才能命中它。只解码，不重新编码。
 * 尺寸不合规则的按原图算；解码不了的抛 texture_file_invalid
 */
export function inspectTexture(bytes: Uint8Array, type: TextureType): InspectedImage {
  let image: Rgba
  try {
    image = decodeTexturePng(bytes, importLimits)
  } catch (error) {
    if (error instanceof PngError) throw new DomainError('texture_file_invalid')
    throw error
  }
  try {
    const normalized = normalizeTexture(image, type)
    return { pixelHash: pixelHash(normalized), width: normalized.width, height: normalized.height, conforming: true }
  } catch (error) {
    if (!(error instanceof TextureShapeError)) throw error
    return { pixelHash: pixelHash(image), width: image.width, height: image.height, conforming: false }
  }
}

export interface RenderInput {
  kind: 'figure' | 'head'
  bytes: Uint8Array
  type: TextureType
  k: number
}
export function renderTexture({ kind, bytes, type, k }: RenderInput): Uint8Array {
  const image = decodeTexturePng(bytes)
  return encodeTexturePng(kind === 'figure' ? renderFigure(image, type, k) : renderHead(image, 'steve', k))
}
