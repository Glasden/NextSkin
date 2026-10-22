import { cx } from '../cx.ts'
import { LogoMark } from '../logo/logo-mark.tsx'

export interface PlayerHeadProps {
  /**
   * 头像的出图地址：服务端渲染的正脸和立体的帽子层（ADR-0056），按出图密度 p 返回。
   * p 是脸上一格占多少个输出像素，等于显示倍数乘设备像素比，浏览器不缩放。
   * 还没有头像时不传，按 fallback 显示同样大小的占位
   */
  src?: (p: number) => string
  /**
   * 不传 src 时的占位。`logo`（默认）是标志的像素图形，给还没设头像的用户；
   * `blank` 是和 FigurePlaceholder 同样画法的空白脸，给还没有皮肤的角色和已经注销的用户，表示这里没有东西
   */
  fallback?: 'logo' | 'blank'
  /** 脸显示成 16、24、32、48px，即 8×8 个标准像素的 2、3、4、6 倍（DESIGN.md §5）。帽子层比脸大一圈，四周各伸出 size / 16 */
  size: 16 | 24 | 32 | 48
  /** 替代文字，例如“Miku 的头像”。头像旁边已经写了名字时传空字符串，读屏软件不再重复 */
  alt: string
}

/**
 * 用户和角色的头像。一律是方形：圆形裁切会切掉边缘的像素（DESIGN.md §5）。
 * 组件按脸排版，帽子层像 BS 的头像那样伸到方框外面，父元素不要裁掉四周。
 * 没有头像时显示标志的图形，或者一块和 FigurePlaceholder 同样画法的空白脸
 */
export function PlayerHead({ src, size, alt, fallback = 'logo' }: PlayerHeadProps) {
  const frame = 'block shrink-0 rounded-none'
  if (!src) {
    return (
      <span
        role={alt ? 'img' : undefined}
        aria-label={alt || undefined}
        aria-hidden={alt ? undefined : true}
        className={cx(
          frame,
          fallback === 'blank' &&
            // 和 FigurePlaceholder 一样由 text 混入 stage 得到（DESIGN.md §2.2）
            'border border-dashed border-[color-mix(in_srgb,var(--color-text)_24%,var(--color-stage))] bg-[color-mix(in_srgb,var(--color-text)_10%,var(--color-stage))]',
        )}
        style={{ width: size, height: size }}
      >
        {/* 标志也是 8×8 的网格，四种尺寸都是整数倍 */}
        {fallback === 'logo' && <LogoMark cell={size / 8} />}
      </span>
    )
  }
  // 出图是 9p×9p，帽子四周各多出半格。p 是奇数时脸左上的边距是 (p - 1) / 2，所以往下取整
  const scale = size / 8,
    outer = 9 * scale,
    inset = Math.floor(scale / 2)
  return (
    <span className={cx(frame, 'relative')} style={{ width: size, height: size }}>
      <img
        src={src(scale)}
        srcSet={`${src(scale)} 1x, ${src(scale * 2)} 2x`}
        width={outer}
        height={outer}
        alt={alt}
        loading="lazy"
        decoding="async"
        draggable={false}
        className="absolute max-w-none [image-rendering:pixelated]"
        style={{ width: outer, height: outer, left: -inset, top: -inset }}
      />
    </span>
  )
}
