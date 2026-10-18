import { RENDERER_VERSION, type TextureType } from '@nextskin/skin'

// 出图地址包含缓存键的全部内容，响应是一年的 immutable（ADR-0017、ADR-0025）

/** SkinFigure 的 src：2D 正背面拼图 */
export function figureSrc(hash: string, model: TextureType): (k: number) => string {
  return (k) => `/render/v${RENDERER_VERSION}/figure/${model}/${k}/${hash}.png`
}

/** PlayerHead 的 src：正脸加帽子层 */
export function headSrc(hash: string): (k: number) => string {
  return (k) => `/render/v${RENDERER_VERSION}/head/${k}/${hash}.png`
}

/** 材质的原始 PNG，游戏客户端也用这个地址 */
export function textureFileUrl(hash: string): string {
  return `/textures/${hash}`
}
