// 上传页在浏览器里处理本地文件：解码、推断类型、出预览（ADR-0017、ADR-0025、ADR-0048）。
// 只为预览和提前提示，服务端会按 ADR-0008 重新把关；解码不用 canvas，见 packages/skin/AGENTS.md

import {
  decodePng,
  inferSkinModel,
  normalizeTexture,
  pickResolution,
  renderFigure,
  renderPose,
  textureScale,
  type Rgba,
  type TextureType,
} from '@nextskin/skin'

// 与服务端相同的解码上限（ADR-0008）
const limits = { maxWidth: 1024, maxHeight: 1024, maxInflatedBytes: 9 * 1024 * 1024 }

/** 解码失败（不是 PNG、文件损坏、超出上限）时返回 null */
export async function decodeLocalTexture(file: File): Promise<Rgba | null> {
  try {
    return await decodePng(new Uint8Array(await file.arrayBuffer()), limits)
  } catch {
    return null
  }
}

/**
 * 按尺寸猜类型：22×17 系列是披风；正方形是新格式的皮肤，再按手臂推断模型；2:1 可能是旧版皮肤也可能是披风，
 * 先当作皮肤，由用户确认。尺寸哪种都不是时返回 null
 */
export function guessTextureType(image: Rgba): TextureType | null {
  const { width, height } = image
  if (width % 22 === 0 && height * 22 === width * 17) return 'cape'
  if (width % 64 === 0 && height === width) return inferSkinModel(image)
  if (width % 64 === 0 && height * 2 === width) return 'steve'
  return null
}

/** 2:1 的图：旧版 64×32 皮肤和披风长得一样大，要用户确认 */
export function isAmbiguous(image: Rgba): boolean {
  return image.width % 64 === 0 && image.height * 2 === image.width
}

export interface LocalPreview {
  type: TextureType
  textureScale: number
  /** 皮肤是"出图密度 p"或"p-raise"（抬手拼图），披风是分辨率 k → blob URL，交给 SkinFigure 的 src */
  urls: ReadonlyMap<string, string>
}

async function toBlobUrl(image: Rgba): Promise<string | null> {
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  canvas
    .getContext('2d')!
    .putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  return blob && URL.createObjectURL(blob)
}

/** 按选定的类型规范化并出图；这个类型放不下这张图时返回 null（例如 64×32 选了 Alex） */
export async function renderLocalPreview(image: Rgba, type: TextureType): Promise<LocalPreview | null> {
  let normalized: Rgba
  try {
    normalized = normalizeTexture(image, type)
  } catch {
    return null
  }
  const s = textureScale(type, normalized.width, normalized.height)
  const urls = new Map<string, string>()
  // 上传页的预览按 ×5 显示（领奖台的大小），1x、2x 两档；皮肤是正背面并排的 3D 出图，连抬手拼图一起出
  const renders: [string, () => Rgba][] =
    type === 'cape'
      ? [...new Set([pickResolution(s, 5, 1), pickResolution(s, 5, 2)])].map((k) => [
          String(k),
          () => renderFigure(normalized, 'cape', k),
        ])
      : [5, 10].flatMap((p) =>
          [false, true].map((raise): [string, () => Rgba] => [
            `${p}${raise ? '-raise' : ''}`,
            () => renderPose(normalized, type, 'both', p, raise),
          ]),
        )
  for (const [key, render] of renders) {
    const url = await toBlobUrl(render())
    if (url) urls.set(key, url)
  }
  return { type, textureScale: s, urls }
}

export function revokePreview(preview: LocalPreview | null): void {
  for (const url of preview?.urls.values() ?? []) URL.revokeObjectURL(url)
}
