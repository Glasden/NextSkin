import { RENDERER_VERSION, type PoseView, type TextureType } from '@nextskin/skin'

// 出图地址包含缓存键的全部内容，响应是一年的 immutable（ADR-0017、ADR-0025、ADR-0048）

/** SkinFigure 的 src：皮肤是 3D 出图（n 是出图密度 p），披风是 2D 正背面拼图（n 是分辨率 k） */
export function figureSrc(hash: string, model: TextureType): (n: number, view: PoseView, raise: boolean) => string {
  if (model === 'cape') return (k) => `/render/v${RENDERER_VERSION}/figure/cape/${k}/${hash}.png`
  return (p, view, raise) => `/render/v${RENDERER_VERSION}/${view}${raise ? '-raise' : ''}/${model}/${p}/${hash}.png`
}

/** PlayerHead 的 src：正脸和立体的帽子层，按出图密度 p 出图（ADR-0056） */
export function headSrc(hash: string): (p: number) => string {
  return (p) => `/render/v${RENDERER_VERSION}/head/${p}/${hash}.png`
}

/** 材质的原始 PNG，游戏客户端也用这个地址 */
export function textureFileUrl(hash: string): string {
  return `/textures/${hash}`
}
