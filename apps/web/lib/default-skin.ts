import type { PoseView, TextureType } from '@nextskin/skin'
import front16 from '@nextskin/skin/assets/figures/default-skin-front-p16.png'
import front4 from '@nextskin/skin/assets/figures/default-skin-front-p4.png'
import front8 from '@nextskin/skin/assets/figures/default-skin-front-p8.png'
import raise16 from '@nextskin/skin/assets/figures/default-skin-front-raise-p16.png'
import raise4 from '@nextskin/skin/assets/figures/default-skin-front-raise-p4.png'
import raise8 from '@nextskin/skin/assets/figures/default-skin-front-raise-p8.png'
import figures from '@nextskin/skin/assets/figures/manifest.json'

// 随核心发布的默认皮肤，预先渲染好只有正面的 3D 出图（packages/skin/assets）：插图按 ×4、×8 显示，1x、2x 两档
const files: Record<string, { src: string }> = {
  'front-p4': front4,
  'front-p8': front8,
  'front-p16': front16,
  'front-raise-p4': raise4,
  'front-raise-p8': raise8,
  'front-raise-p16': raise16,
}

/** 空站点的登录页、安装页、维护页插图：传给 SkinFigure，再加 scale（4 或 8）和替代文字 */
export const defaultSkin = {
  type: figures.figures['default-skin'].type as TextureType,
  textureScale: figures.figures['default-skin'].textureScale,
  view: 'front' as const,
  src(p: number, _view: PoseView, raise: boolean): string {
    const file = files[`front${raise ? '-raise' : ''}-p${p}`]
    if (!file) throw new Error(`默认皮肤没有 p = ${p} 的出图（packages/skin/scripts/assets.ts）`)
    return file.src
  },
}
