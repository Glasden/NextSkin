import type { CSSProperties } from 'react'
import repoData from '../gen/repo-data.json'

// 和 packages/skin/src/pose.ts 同一套几何：部位是盒子，外层按游戏的膨胀量放大；
// 这里的相机角度可以变，转到 30°、俯视 18° 时和 renderPose 的出图逐格重合

/** 宽、高、深，中心 x、y，外层膨胀量（纤细模型） */
const PARTS = [
  [8, 8, 8, 0, 28, 0.5],
  [8, 12, 4, 0, 18, 0.25],
  [3, 12, 4, -5.5, 18, 0.25],
  [3, 12, 4, 5.5, 18, 0.25],
  [4, 12, 4, -2, 6, 0.25],
  [4, 12, 4, 2, 6, 0.25],
] as const

export const PART_COUNT = PARTS.length
export const YAW = Math.PI / 6
export const PITCH = (Math.PI / 180) * 18

type V3 = [number, number, number]

function project([x, y, z]: V3, yaw: number, pitch: number): V3 {
  const x1 = x * Math.cos(yaw) + z * Math.sin(yaw)
  const z1 = z * Math.cos(yaw) - x * Math.sin(yaw)
  return [x1, z1 * Math.sin(pitch) - y * Math.cos(pitch), y * Math.sin(pitch) + z1 * Math.cos(pitch)]
}

function corners(part: (typeof PARTS)[number], inflate: number): V3[] {
  const [w, h, d, cx, cy] = part
  return Array.from({ length: 8 }, (_, i) => [
    cx + (i & 1 ? 1 : -1) * (w / 2 + inflate),
    cy + (i & 2 ? 1 : -1) * (h / 2 + inflate),
    (i & 4 ? 1 : -1) * (d / 2 + inflate),
  ])
}

// 12 条棱：只差一位的两个角
const EDGES = Array.from({ length: 8 }, (_, a) => [1, 2, 4].map((bit) => [a, a | bit] as const))
  .flat()
  .filter(([a, b]) => a !== b)

// 面：四个角的序号和法线
const FACES: { idx: [number, number, number, number]; n: V3 }[] = [
  { idx: [4, 5, 7, 6], n: [0, 0, 1] },
  { idx: [0, 1, 3, 2], n: [0, 0, -1] },
  { idx: [0, 4, 6, 2], n: [-1, 0, 0] },
  { idx: [1, 5, 7, 3], n: [1, 0, 0] },
  { idx: [2, 3, 7, 6], n: [0, 1, 0] },
  { idx: [0, 1, 5, 4], n: [0, -1, 0] },
]

/** 明暗的三档（pose.ts 的 shadeOf）：顶面、正面、侧面 */
export type ShadeClass = 'top' | 'front' | 'side'

function shadeClass(n: V3): ShadeClass | null {
  const [cx, cy, cz] = project(n, YAW, PITCH)
  if (cz <= 1e-9) return null
  const shade = Math.max(0.4, Math.min(1, 0.7 + 0.08 * cx - 0.23 * cy + 0.27 * cz))
  return shade > 0.95 ? 'top' : shade > 0.8 ? 'front' : 'side'
}

/**
 * 正面视角的线框，坐标和出图一样以标准像素为单位，density 放大。
 * parts 是画出来的部位数，outer 是外层（虚线）画到第几个，highlight 把某一档明暗的面涂上强调色
 */
export function Wireframe({
  density,
  yaw = YAW,
  parts = PART_COUNT,
  outer = 0,
  highlight,
  style,
}: {
  density: number
  yaw?: number
  parts?: number
  outer?: number
  highlight?: ShadeClass
  style?: CSSProperties
}) {
  const { width, height, x: ox, y: oy } = repoData.pose.front
  const at = (p: V3) => {
    const [sx, sy] = project(p, yaw, PITCH)
    return `${(sx + ox) * density},${(sy + oy) * density}`
  }
  const box = (part: (typeof PARTS)[number], inflate: number, dashed: boolean, key: string) => {
    const k = corners(part, inflate)
    return (
      <path
        key={key}
        d={EDGES.map(([a, b]) => `M${at(k[a]!)}L${at(k[b]!)}`).join('')}
        className="stroke-accent"
        strokeOpacity={dashed ? 0.7 : 1}
        strokeWidth={dashed ? 1.5 : 2}
        strokeDasharray={dashed ? '6 4' : undefined}
        fill="none"
      />
    )
  }
  const faces = highlight
    ? PARTS.flatMap((part) => {
        const k = corners(part, part[5])
        return FACES.filter((f) => shadeClass(f.n) === highlight).map((f) => ({
          points: f.idx.map((i) => at(k[i]!)).join(' '),
          depth: f.idx.reduce((sum, i) => sum + project(k[i]!, YAW, PITCH)[2], 0),
        }))
      }).sort((a, b) => a.depth - b.depth)
    : []
  return (
    <svg
      aria-hidden
      width={width * density}
      height={height * density}
      className="absolute overflow-visible"
      style={style}
    >
      {faces.map((f, i) => (
        <polygon key={i} points={f.points} className="fill-accent stroke-accent" fillOpacity={0.35} strokeWidth={2} />
      ))}
      {PARTS.slice(0, parts).map((part, i) => box(part, 0, false, `in${i}`))}
      {PARTS.slice(0, outer).map((part, i) => box(part, part[5], true, `out${i}`))}
    </svg>
  )
}
