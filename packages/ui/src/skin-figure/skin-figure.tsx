import { pickResolution, poseLayout, type PoseView, type TextureType } from '@nextskin/skin'
import { cx } from '../cx.ts'
import { PoseFrames } from './pose-frames.tsx'

/**
 * 出图地址。皮肤是服务端的 3D 出图（ADR-0048）：按视角、是不是抬手拼图和出图密度 n 返回地址，
 * n 是一个标准像素占多少个输出像素，等于显示倍数乘设备像素比，浏览器不缩放。
 * 披风是 2D 正背面拼图（ADR-0017）：n 是分辨率 k，不看视角和抬手
 */
export type FigureSrc = (n: number, view: PoseView, raise: boolean) => string

export interface SkinFigureProps {
  src: FigureSrc
  /** 皮肤是立体的人物，脚下有投影；披风是平的正面和背面并排，没有投影 */
  type: TextureType
  /** 材质的倍数 s：宽度 ÷ 64（22×17 系列的披风是宽度 ÷ 22）。只有披风用它挑分辨率 */
  textureScale: number
  /** 一个标准像素显示成多少 CSS 像素：迷你卡片 3、材质卡片 4、领奖台 5、登录页插图 8（DESIGN.md §5） */
  scale: 3 | 4 | 5 | 8
  /** both 是背面在左、正面在右（材质卡片、角色卡）；front 只有正面（领奖台、插图）。披风不看它 */
  view?: PoseView
  /** “材质名 + 类型”，例如“初音未来的皮肤”（DESIGN.md §9） */
  alt: string
  /**
   * 鼠标移到人物上时抬手。不开时，祖先元素带 `group/raise` 类也能触发：鼠标移上去或键盘聚焦它时抬手。
   * 材质卡片、角色卡和领奖台用后一种
   */
  raiseOnHover?: boolean
  /** 列表里用默认的 lazy；首屏的大图（登录页插图）用 eager */
  loading?: 'lazy' | 'eager'
}

// 投影和网格线一样由 text 混入 stage 得到（DESIGN.md §2.2）
const shadowFill = 'fill-[color-mix(in_srgb,var(--color-text)_16%,var(--color-stage))]'

/**
 * 材质的 3D 人物（皮肤）或 2D 正背面（披风），放在 `stage` 底色上（Stage 或卡片的展台区）。
 * 组件按站着的人物排版，抬起的手臂伸到方框外面，父元素不要裁掉两侧。需要拖动看各个角度时改用 SkinViewer（DESIGN.md §6）
 */
export function SkinFigure({
  src,
  type,
  textureScale,
  scale,
  view = 'both',
  alt,
  raiseOnHover = false,
  loading = 'lazy',
}: SkinFigureProps) {
  if (type === 'cape')
    return <CapeFigure src={src} textureScale={textureScale} scale={scale} alt={alt} loading={loading} />
  const layout = poseLayout(view)
  const { box } = layout
  const source = (raise: boolean) => ({
    src: src(scale, view, raise),
    srcSet: `${src(scale, view, raise)} 1x, ${src(scale * 2, view, raise)} 2x`,
  })
  const frame = {
    width: layout.width * scale,
    height: layout.height * scale,
    left: -box.x * scale,
    top: -box.y * scale,
  }
  return (
    <span
      className={cx('relative inline-block shrink-0', raiseOnHover && 'group/raise')}
      style={{ width: box.width * scale, height: box.height * scale }}
    >
      {/* 硬边投影：地面上一块矩形投到画面里，压在脚下 */}
      <svg
        aria-hidden
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        shapeRendering="crispEdges"
        className={cx('absolute', shadowFill)}
        style={frame}
      >
        {layout.shadows.map((points) => (
          <polygon key={points.join()} points={points.join(' ')} />
        ))}
      </svg>
      {/* 换了材质就换掉整个人物，抬手拼图不会沿用上一张的 */}
      <PoseFrames
        key={src(scale, view, false)}
        still={source(false)}
        sprite={source(true)}
        alt={alt}
        loading={loading}
        {...frame}
      />
    </span>
  )
}

function CapeFigure({
  src,
  textureScale,
  scale,
  alt,
  loading,
}: Pick<SkinFigureProps, 'src' | 'textureScale' | 'scale' | 'alt'> & { loading: 'lazy' | 'eager' }) {
  // 正面和背面左右拼成一张，各 10×16 个标准像素；按显示倍数和设备像素比挑 k，浏览器只做整数倍放大
  const width = 20 * scale,
    height = 16 * scale
  const k1 = pickResolution(textureScale, scale, 1),
    k2 = pickResolution(textureScale, scale, 2)
  return (
    <img
      src={src(k1, 'both', false)}
      srcSet={k2 === k1 ? undefined : `${src(k1, 'both', false)} 1x, ${src(k2, 'both', false)} 2x`}
      alt={alt}
      width={width}
      height={height}
      loading={loading}
      decoding="async"
      draggable={false}
      className="block max-w-none shrink-0 [image-rendering:pixelated]"
      style={{ width, height }}
    />
  )
}
