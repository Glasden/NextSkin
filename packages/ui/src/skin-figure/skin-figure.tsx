import { pickResolution, type TextureType } from '@nextskin/skin'
import { cx } from '../cx.ts'

export interface SkinFigureProps {
  /**
   * 出图地址：服务端渲染的正背面拼图（ADR-0017），左半是正面，右半是背面。
   * 按分辨率 k（一个标准像素在图里占 k×k 个像素）返回地址；组件按显示倍数和设备像素比挑 k，浏览器只做整数倍放大
   */
  src: (k: number) => string
  /** 皮肤显示成 16×32 个标准像素，站着，脚下有投影；披风是 10×16，没有投影 */
  type: TextureType
  /** 材质的倍数 s：宽度 ÷ 64（22×17 系列的披风是宽度 ÷ 22） */
  textureScale: number
  /** 一个标准像素显示成多少 CSS 像素：迷你卡片 3、材质卡片 4、领奖台 5、登录页插图 8（DESIGN.md §5） */
  scale: 3 | 4 | 5 | 8
  /** “材质名 + 类型”，例如“初音未来的皮肤”（DESIGN.md §9） */
  alt: string
  /**
   * 鼠标移到人物上时转身。不开时，祖先元素带 `group/turn` 类也能触发：鼠标移上去或键盘聚焦它时转身。
   * 材质卡片和领奖台用后一种
   */
  turnOnHover?: boolean
  /** 列表里用默认的 lazy；首屏的大图（登录页插图）用 eager */
  loading?: 'lazy' | 'eager'
}

// 转身分两段，每段四格（DESIGN.md §2.2）：正面横向缩到 0，再展开背面；转回来时反过来。减少动态效果时不转
const half = 'absolute inset-0 overflow-hidden transition-transform duration-fast ease-step'
const front = cx(
  half,
  'delay-(--duration-fast)',
  'motion-safe:group-hover/turn:scale-x-0 motion-safe:group-hover/turn:delay-0',
  'motion-safe:group-focus-visible/turn:scale-x-0 motion-safe:group-focus-visible/turn:delay-0',
)
const back = cx(
  half,
  'scale-x-0 delay-0',
  'motion-safe:group-hover/turn:scale-x-100 motion-safe:group-hover/turn:delay-(--duration-fast)',
  'motion-safe:group-focus-visible/turn:scale-x-100 motion-safe:group-focus-visible/turn:delay-(--duration-fast)',
)

/**
 * 材质的 2D 正面和背面，带转身和脚下投影。放在 `stage` 底色上（Stage 或卡片的展台区）。
 * 需要拖动看各个角度时改用 SkinViewer（DESIGN.md §6）
 */
export function SkinFigure({
  src,
  type,
  textureScale,
  scale,
  alt,
  turnOnHover = false,
  loading = 'lazy',
}: SkinFigureProps) {
  const isCape = type === 'cape'
  const width = (isCape ? 10 : 16) * scale
  const height = (isCape ? 16 : 32) * scale
  const k1 = pickResolution(textureScale, scale, 1)
  const k2 = pickResolution(textureScale, scale, 2)
  const image = {
    src: src(k1),
    srcSet: k2 === k1 ? undefined : `${src(k1)} 1x, ${src(k2)} 2x`,
    width: width * 2,
    height,
    loading,
    decoding: 'async' as const,
    draggable: false,
    className: 'block max-w-none [image-rendering:pixelated]',
    style: { width: width * 2, height },
  }

  return (
    <span className={cx('relative inline-block shrink-0', turnOnHover && 'group/turn')} style={{ width, height }}>
      {!isCape && (
        // 硬边投影：12 个标准像素宽、1 个高，压在脚底那条线上，一半在人物身后
        <span
          aria-hidden
          className="absolute left-1/2 -translate-x-1/2 bg-[color-mix(in_srgb,var(--color-text)_16%,var(--color-stage))]"
          style={{ width: 12 * scale, height: scale, bottom: -Math.ceil(scale / 2) }}
        />
      )}
      <span className={front}>
        <img {...image} alt={alt} />
      </span>
      <span aria-hidden className={back}>
        <img {...image} alt="" className={cx(image.className, '-translate-x-1/2')} />
      </span>
    </span>
  )
}
