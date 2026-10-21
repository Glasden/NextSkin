import { PngError, type PngLimits, type Rgba } from '@nextskin/skin'
import { DomainError } from '../errors.ts'
import { decodeTexturePng, encodeTexturePng, pixelHash } from '../textures/image.ts'

/** 上传的站点图片（ADR-0042"收什么图"）：PNG，正方形，边长 16～512，文件不超过 1 MiB */
export const SITE_IMAGE_MAX_BYTES = 1024 * 1024
export const SITE_IMAGE_MIN_SIDE = 16
export const SITE_IMAGE_MAX_SIDE = 512
/** 边长不到它的当作像素画，按最近邻放大到不小于它的最小整数倍 */
const PIXEL_ART_SIDE = 64

const limits: PngLimits = {
  maxWidth: SITE_IMAGE_MAX_SIDE,
  maxHeight: SITE_IMAGE_MAX_SIDE,
  // 16 位 RGBA 的扫描行加上每行一个滤波字节
  maxInflatedBytes: SITE_IMAGE_MAX_SIDE * (SITE_IMAGE_MAX_SIDE * 8 + 1),
}

export interface SiteImage {
  pixelHash: string
  /** 重新编码过的图，只有像素 */
  png: Uint8Array
  /** 铺白底的同一张图，给 iOS 的主屏幕图标：iOS 会把透明的部分填成黑色 */
  opaque: Uint8Array
}

function upscale(image: Rgba, factor: number): Rgba {
  const width = image.width * factor
  const data = new Uint8Array(width * width * 4)
  const source = new Uint32Array(image.data.buffer, image.data.byteOffset, image.width * image.height)
  const target = new Uint32Array(data.buffer)
  for (let y = 0; y < width; y++) {
    const row = Math.floor(y / factor) * image.width
    for (let x = 0; x < width; x++) target[y * width + x] = source[row + Math.floor(x / factor)]!
  }
  return { width, height: width, data }
}

function flatten(image: Rgba): Rgba {
  const data = new Uint8Array(image.data.length)
  for (let i = 0; i < data.length; i += 4) {
    const alpha = image.data[i + 3]!
    for (let channel = 0; channel < 3; channel++)
      data[i + channel] = Math.round((image.data[i + channel]! * alpha + 255 * (255 - alpha)) / 255)
    data[i + 3] = 255
  }
  return { width: image.width, height: image.height, data }
}

/** 在图像 worker 里运行：解码、检查尺寸、像素画放大、重新编码，另出一份白底的 */
export function processSiteImage(bytes: Uint8Array): SiteImage {
  if (bytes.length > SITE_IMAGE_MAX_BYTES) throw new DomainError('site_image_file_invalid')
  let image: Rgba
  try {
    image = decodeTexturePng(bytes, limits)
  } catch (error) {
    if (error instanceof PngError && error.dimensions)
      throw new DomainError('site_image_size_invalid', error.dimensions)
    throw new DomainError('site_image_file_invalid')
  }
  if (image.width !== image.height || image.width < SITE_IMAGE_MIN_SIDE)
    throw new DomainError('site_image_size_invalid', { width: image.width, height: image.height })
  if (image.width < PIXEL_ART_SIDE) image = upscale(image, Math.ceil(PIXEL_ART_SIDE / image.width))
  return { pixelHash: pixelHash(image), png: encodeTexturePng(image), opaque: encodeTexturePng(flatten(image)) }
}
