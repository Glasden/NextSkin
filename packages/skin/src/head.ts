import { over } from './composite.ts'
import { prepareSkin, TextureShapeError, type Rgba } from './index.ts'

/** 头像出图密度 p 的上限：48px 的头像在 2x 屏上是 12，OIDC 的 picture 按 16 出 144×144 */
export const MAX_HEAD_DENSITY = 16

/** 头像的宽高：脸是 8×8 个标准像素，帽子层四周各多出半格，一共 9 格乘 p */
export function headSize(p: number): number {
  if (!Number.isSafeInteger(p) || p < 1 || p > MAX_HEAD_DENSITY) {
    throw new TextureShapeError(`出图密度 p 必须是 1 到 ${MAX_HEAD_DENSITY} 的整数`)
  }
  return 9 * p
}

/**
 * 头像：正对着脸的正交视图，和 BS 的 2D 头像一样（ADR-0056）。帽子层是按游戏的膨胀量放大的盒子
 * （每边多 0.5 个标准像素，同 renderPose），所以比脸大一圈、四周各伸出半格；帽子正面透明的地方，
 * 露出帽子背面的内侧（从里面看，左右镜像）。
 * p 是脸上一格占多少个输出像素，等于显示倍数乘设备像素比，浏览器不缩放；帽子的一格是 9p/8 个像素，宽窄不一。
 * p 是奇数时脸左上的边距是 (p - 1) / 2，右下多一个像素
 */
export function renderHead(image: Rgba, p: number): Rgba {
  const size = headSize(p)
  const skin = prepareSkin(image)
  const s = skin.width / 64
  const out: Rgba = { width: size, height: size, data: new Uint8Array(size * size * 4) }
  // 按输出像素的中心取样，全用整数算：中心在 (2x + 1) / 2，帽子从 0 到 9p 分 8 格，脸从 p/2 到 8.5p 分 8 格
  for (let y = 0; y < size; y++) {
    const hy = 8 * s + Math.floor(((2 * y + 1) * 4 * s) / (9 * p)),
      fy = 2 * y + 1 - p
    for (let x = 0; x < size; x++) {
      const hx = Math.floor(((2 * x + 1) * 4 * s) / (9 * p)),
        fx = 2 * x + 1 - p
      const o = (y * size + x) * 4
      if (fx >= 0 && fx < 16 * p && fy >= 0 && fy < 16 * p) {
        // 脸 (8, 8) 是不透明的基础层，盖住后面的一切
        const q = ((8 * s + Math.floor((fy * s) / (2 * p))) * skin.width + 8 * s + Math.floor((fx * s) / (2 * p))) * 4
        for (let c = 0; c < 4; c++) out.data[o + c] = skin.data[q + c]!
      } else {
        // 脸外面的一圈：帽子背面 (56, 8) 的内侧，左右镜像
        const q = (hy * skin.width + 64 * s - 1 - hx) * 4
        if (skin.data[q + 3]) for (let c = 0; c < 4; c++) out.data[o + c] = skin.data[q + c]!
      }
      // 帽子正面 (40, 8) 叠在最上面
      over(out.data, o, skin.data, (hy * skin.width + 40 * s + hx) * 4)
    }
  }
  return out
}
