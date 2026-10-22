import { checker, cx, LOGO_MARK, LOGO_MARK_COLORS, type LogoMarkColor } from '@nextskin/ui'
import type { CSSProperties } from 'react'
import repoData from '../gen/repo-data.json'
import { useDensity } from './time.ts'

// 展示材质只有一张：cxchency 的皮肤（packages/skin/assets/README.md），纤细模型，64×64
export const SKIN = '/gen/skin/default-skin.png'

/** 版式的宽高（标准像素），取自 packages/skin 的 poseLayout */
export const POSE = {
  front: { width: repoData.pose.front.width, height: repoData.pose.front.height },
  both: { width: repoData.pose.both.width, height: repoData.pose.both.height },
} as const

/**
 * 仓库的 renderPose 出的图（scripts/figures.ts 生成）。density 是画面上一个标准像素占几个排版像素；
 * 画面缩放到 2 个以上设备像素时换 2 倍的图，像素照样锐利（DESIGN.md §5）。抬手拼图用 frame 选第几帧
 */
export function PoseImage({
  name,
  view,
  density,
  frame = 0,
  frames = 1,
  style,
}: {
  name: string
  view: keyof typeof POSE
  density: number
  frame?: number
  frames?: number
  style?: CSSProperties
}) {
  const scale = useDensity() >= 2 ? 2 : 1
  const w = POSE[view].width * density
  const h = POSE[view].height * density
  return (
    <div className="relative shrink-0 overflow-hidden" style={{ width: w, height: h, ...style }}>
      <img
        src={`/gen/pose/${name}.${scale}x.png`}
        alt=""
        className="pixelated block max-w-none"
        style={{ width: w * frames, height: h, marginLeft: -frame * w }}
      />
    </div>
  )
}

/** 头像：材质 8×8 的面部加帽子层，方形、整数倍（DESIGN.md §5） */
export function Head({ size }: { size: 16 | 24 | 32 | 48 | 64 | 96 }) {
  const k = size / 8
  const layer = (x: number) => (
    <img
      src={SKIN}
      alt=""
      className="pixelated absolute block max-w-none"
      style={{ width: 64 * k, height: 64 * k, left: -x * k, top: -8 * k }}
    />
  )
  return (
    <div className="relative shrink-0 overflow-hidden" style={{ width: size, height: size }}>
      {layer(8)}
      {layer(40)}
    </div>
  )
}

/** 原始材质，透明处是 8px 的棋盘格 */
export function RawTexture({ scale }: { scale: number }) {
  const size = 64 * scale
  return (
    <div className={checker} style={{ width: size, height: size }}>
      <img
        src={SKIN}
        alt="default-skin.png"
        className="pixelated block max-w-none"
        style={{ width: size, height: size }}
      />
    </div>
  )
}

const fills: Record<LogoMarkColor, string> = {
  accent: 'fill-accent',
  'accent-fg': 'fill-accent-fg',
  'text-muted': 'fill-text-muted',
  'border-strong': 'fill-border-strong',
}

const cells = LOGO_MARK.flatMap((row, y) =>
  [...row].flatMap((ch, x) =>
    ch === '.' ? [] : [{ x, y, color: LOGO_MARK_COLORS[ch as keyof typeof LOGO_MARK_COLORS] }],
  ),
)

export const LOGO_CELLS = cells.length

/**
 * 标志：折起来的头（packages/ui 的 LOGO_MARK），一格一个矩形。
 * visible 按格子的出场顺序给出不透明度，用来做逐格出现；不给就整个画出来
 */
export function LogoCells({
  cell,
  visible,
  order,
}: {
  cell: number
  visible?: (rank: number) => number
  order?: readonly number[]
}) {
  const size = 8 * cell
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 8 8"
      shapeRendering="crispEdges"
      className="block shrink-0"
    >
      {cells.map((m, i) => {
        const o = visible ? visible(order ? order[i]! : i) : 1
        if (o <= 0) return null
        return <rect key={i} x={m.x} y={m.y} width={1} height={1} opacity={o} className={cx(fills[m.color])} />
      })}
    </svg>
  )
}
