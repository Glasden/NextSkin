import { pickResolution } from '@nextskin/skin'
import { cx } from '../cx.ts'

export interface PlayerHeadProps {
  /**
   * 头像的出图地址：服务端渲染的正脸加帽子层（ADR-0025），按分辨率 k 返回。
   * 还没有头像时不传，显示同样大小的占位
   */
  src?: (k: number) => string
  /** 皮肤的倍数 s：宽度 ÷ 64。不传 src 时忽略 */
  textureScale?: number
  /** 显示成 16、24、32、48px：脸是 8×8 个标准像素，只做整数倍放大（DESIGN.md §5） */
  size: 16 | 24 | 32 | 48
  /** 替代文字，例如“Miku 的头像”。头像旁边已经写了名字时传空字符串，读屏软件不再重复 */
  alt: string
}

/**
 * 用户和角色的头像。一律是方形：圆形裁切会切掉边缘的像素（DESIGN.md §5）。
 * 没有头像时显示一块和 FigurePlaceholder 同样画法的空白脸
 */
export function PlayerHead({ src, textureScale = 1, size, alt }: PlayerHeadProps) {
  const frame = 'block shrink-0 rounded-none'
  if (!src) {
    return (
      <span
        role={alt ? 'img' : undefined}
        aria-label={alt || undefined}
        aria-hidden={alt ? undefined : true}
        className={cx(
          frame,
          // 和 FigurePlaceholder 一样由 text 混入 stage 得到（DESIGN.md §2.2）
          'border border-dashed border-[color-mix(in_srgb,var(--color-text)_24%,var(--color-stage))] bg-[color-mix(in_srgb,var(--color-text)_10%,var(--color-stage))]',
        )}
        style={{ width: size, height: size }}
      />
    )
  }
  const scale = size / 8
  const k1 = pickResolution(textureScale, scale, 1)
  const k2 = pickResolution(textureScale, scale, 2)
  return (
    <img
      src={src(k1)}
      srcSet={k2 === k1 ? undefined : `${src(k1)} 1x, ${src(k2)} 2x`}
      width={size}
      height={size}
      alt={alt}
      loading="lazy"
      decoding="async"
      draggable={false}
      className={cx(frame, '[image-rendering:pixelated]')}
      style={{ width: size, height: size }}
    />
  )
}
