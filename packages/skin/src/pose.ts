import { over } from './composite.ts'
import { prepareSkin, TextureShapeError, textureScale, type Rgba } from './index.ts'

/** 3D 出图的视角：both 是背面在左、正面在右（皮肤库卡片）；front 只有正面（领奖台、插图） */
export type PoseView = 'both' | 'front'

/** 抬手拼图的帧数：第 0 帧站着，和静止图逐像素相同；后面四格把左臂从身侧举过头顶（DESIGN.md §2.2） */
export const RAISE_FRAMES = 5

/** 出图密度 p（一个标准像素占 p×p 个输出像素）的上限：登录页插图 ×8 在 2x 屏上是 16 */
export const MAX_POSE_DENSITY = 16

/** 一帧的版式，单位都是标准像素；同一视角的皮肤（经典、纤细）版式相同 */
export interface PoseLayout {
  /** 一帧的宽高，包括抬起的手臂扫过的地方 */
  readonly width: number
  readonly height: number
  /** 站着时人物占的方框在帧里的位置。页面按它排版，抬起的手臂伸到方框外面 */
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  /** 每个人物脚下的投影：地面上一块矩形投到画面里的四个顶点，帧坐标，依次是 x0 y0 x1 y1 x2 y2 x3 y3 */
  readonly shadows: readonly (readonly number[])[]
}

// 相机：绕竖直轴转 30°，再俯视 18°，正交投影。正面看得到脸和人物的右侧，背面看得到后背和左侧。
// 三角函数写成字面量：各个 JS 引擎的 Math.cos 不保证逐位相同，出图要逐位稳定（黄金图、ADR-0017 的缓存）
const YAW_COS = 0.8660254037844387
const YAW_SIN = 0.49999999999999994
const PITCH_COS = 0.9510565162951535
const PITCH_SIN = 0.3090169943749474
// 左臂绕肩膀侧举的角度：0、37.5°、75°、112.5°、150°，各帧的 cos、sin
const RAISE = [
  [1, 0],
  [0.7933533402912352, 0.6087614290087207],
  [0.25881904510252074, 0.9659258262890683],
  [-0.3826834323650897, 0.9238795325112867],
  [-0.8660254037844387, 0.49999999999999994],
] as const
// 肩膀：手臂的转轴，和游戏里的玩家模型一样在手臂顶端往下 2 格、往里 1 格
const SHOULDER_X = 5
const SHOULDER_Y = 22
// 背面和正面两个人物站着时的间距
const GAP = 3
// 脚下投影：地面上 12×8 的矩形
const SHADOW_HALF_X = 6
const SHADOW_HALF_Z = 4

// 部位：宽、高、深，中心 x、y，内层 UV，外层 UV，外层向外膨胀多少，是不是抬起的左臂。
// 原点在两脚中间的地面上，x 朝人物的左手边（正面看是画面右侧），y 朝上，z 朝人物的正前方
type Part = readonly [number, number, number, number, number, number, number, number, number, number, boolean]
function parts(slim: boolean): readonly Part[] {
  const a = slim ? 3 : 4
  return [
    [8, 8, 8, 0, 28, 0, 0, 32, 0, 0.5, false],
    [8, 12, 4, 0, 18, 16, 16, 16, 32, 0.25, false],
    [a, 12, 4, -4 - a / 2, 18, 40, 16, 40, 32, 0.25, false],
    [a, 12, 4, 4 + a / 2, 18, 32, 48, 48, 48, 0.25, true],
    [4, 12, 4, -2, 6, 0, 16, 0, 32, 0.25, false],
    [4, 12, 4, 2, 6, 16, 48, 0, 48, 0.25, false],
  ]
}

// 屏幕坐标：x 朝右，y 朝下，z 朝相机（越大越近）。yaw 为 +1 是正面，-1 是背面（多转 180°）
function toScreen(x: number, y: number, z: number, yaw: number, out: number[], at: number): void {
  const x1 = (x * YAW_COS + z * YAW_SIN) * yaw
  const z1 = (z * YAW_COS - x * YAW_SIN) * yaw
  out[at] = x1
  out[at + 1] = z1 * PITCH_SIN - y * PITCH_COS
  out[at + 2] = y * PITCH_SIN + z1 * PITCH_COS
}

// 部位局部坐标（相对盒子中心）到世界坐标；抬起的左臂先绕肩膀转
function toWorld(part: Part, frame: number, x: number, y: number, z: number, out: number[]): void {
  const [, , , cx, cy] = part
  if (part[10] && frame > 0) {
    const [cos, sin] = RAISE[frame]!
    const lx = x + cx - SHOULDER_X,
      ly = y + cy - SHOULDER_Y
    out[0] = lx * cos - ly * sin + SHOULDER_X
    out[1] = lx * sin + ly * cos + SHOULDER_Y
  } else {
    out[0] = x + cx
    out[1] = y + cy
  }
  out[2] = z
}

function rotateNormal(part: Part, frame: number, x: number, y: number, out: number[]): void {
  if (part[10] && frame > 0) {
    const [cos, sin] = RAISE[frame]!
    out[0] = x * cos - y * sin
    out[1] = x * sin + y * cos
  } else {
    out[0] = x
    out[1] = y
  }
}

interface Bounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

// 一个视角在若干帧里的屏幕包围盒（相对原点），外层按膨胀后的大小算
function bounds(yaw: number, frames: number): Bounds {
  const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
  const world = [0, 0, 0],
    screen = [0, 0, 0]
  for (let frame = 0; frame < frames; frame++) {
    for (const part of parts(false)) {
      const [w, h, d] = part,
        i = part[9]
      for (let corner = 0; corner < 8; corner++) {
        const x = (corner & 1 ? 1 : -1) * (w / 2 + i),
          y = (corner & 2 ? 1 : -1) * (h / 2 + i),
          z = (corner & 4 ? 1 : -1) * (d / 2 + i)
        toWorld(part, frame, x, y, z, world)
        toScreen(world[0]!, world[1]!, world[2]!, yaw, screen, 0)
        b.minX = Math.min(b.minX, screen[0]!)
        b.maxX = Math.max(b.maxX, screen[0]!)
        b.minY = Math.min(b.minY, screen[1]!)
        b.maxY = Math.max(b.maxY, screen[1]!)
      }
    }
  }
  return b
}

interface Placement extends PoseLayout {
  /** 每个人物的 yaw 和原点在帧里的位置（整数，标准像素） */
  readonly figures: readonly { readonly yaw: number; readonly x: number; readonly y: number }[]
}

const placements = new Map<PoseView, Placement>()
function place(view: PoseView): Placement {
  const cached = placements.get(view)
  if (cached) return cached
  const yaws = view === 'both' ? [-1, 1] : [1]
  const rest = yaws.map((yaw) => bounds(yaw, 1)),
    full = yaws.map((yaw) => bounds(yaw, RAISE_FRAMES))
  // 原点放在整数坐标上：1x、2x 两档的版式正好差一倍
  const xs = [-Math.floor(full[0]!.minX)]
  if (view === 'both') xs.push(xs[0]! + Math.ceil(rest[0]!.maxX - rest[1]!.minX + GAP))
  const y = -Math.floor(Math.min(...full.map((b) => b.minY)))
  const width = Math.ceil(Math.max(...full.map((b, i) => b.maxX + xs[i]!)))
  const height = Math.ceil(Math.max(...full.map((b) => b.maxY)) + y)
  const left = Math.floor(Math.min(...rest.map((b, i) => b.minX + xs[i]!))),
    right = Math.ceil(Math.max(...rest.map((b, i) => b.maxX + xs[i]!))),
    top = Math.floor(Math.min(...rest.map((b) => b.minY)) + y),
    bottom = Math.ceil(Math.max(...rest.map((b) => b.maxY)) + y)
  const screen = [0, 0, 0]
  const shadows = yaws.map((yaw, i) => {
    const points: number[] = []
    for (const [sx, sz] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      toScreen(sx * SHADOW_HALF_X, 0, sz * SHADOW_HALF_Z, yaw, screen, 0)
      points.push(screen[0]! + xs[i]!, screen[1]! + y)
    }
    return points
  })
  const result: Placement = {
    width,
    height,
    box: { x: left, y: top, width: right - left, height: bottom - top },
    shadows,
    figures: yaws.map((yaw, i) => ({ yaw, x: xs[i]!, y })),
  }
  placements.set(view, result)
  return result
}

/** 这个视角的版式。组件和出图共用，组件不读像素 */
export function poseLayout(view: PoseView): PoseLayout {
  const { width, height, box, shadows } = place(view)
  return { width, height, box, shadows }
}

/** 出图的尺寸：一帧是版式的宽高乘 p，抬手拼图把各帧从左到右排开 */
export function poseSize(view: PoseView, p: number, raise: boolean): { width: number; height: number } {
  checkDensity(p)
  const { width, height } = place(view)
  return { width: width * p * (raise ? RAISE_FRAMES : 1), height: height * p }
}

function checkDensity(p: number): void {
  if (!Number.isSafeInteger(p) || p < 1 || p > MAX_POSE_DENSITY) {
    throw new TextureShapeError(`出图密度 p 必须是 1 到 ${MAX_POSE_DENSITY} 的整数`)
  }
}

// 一个要画的面：屏幕上的原点和两条边（输出像素），起点的深度和两条边上的深度变化，UV 矩形，明暗
interface Face {
  ox: number
  oy: number
  ux: number
  uy: number
  vx: number
  vy: number
  oz: number
  uz: number
  vz: number
  tx: number
  ty: number
  tw: number
  th: number
  shade: number
  depth: number
}

// 面：局部的起点角、u 边、v 边（按半边长的倍数）、法线，以及 UV 矩形（相对部位的 UV 原点）。
// u 边对应 UV 矩形的从左到右，v 边对应从上到下；底面在材质上上下颠倒，和游戏一致
type Vec = readonly [number, number, number]
interface FaceShape {
  readonly o: Vec
  readonly u: Vec
  readonly v: Vec
  readonly n: Vec
  readonly rect: (w: number, h: number, d: number) => readonly [number, number, number, number]
}
const FACES: readonly FaceShape[] = [
  // 正面、背面、右侧（x 负）、左侧、顶面、底面
  { o: [-1, 1, 1], u: [2, 0, 0], v: [0, -2, 0], n: [0, 0, 1], rect: (w, h, d) => [d, d, w, h] },
  { o: [1, 1, -1], u: [-2, 0, 0], v: [0, -2, 0], n: [0, 0, -1], rect: (w, h, d) => [2 * d + w, d, w, h] },
  { o: [-1, 1, -1], u: [0, 0, 2], v: [0, -2, 0], n: [-1, 0, 0], rect: (_, h, d) => [0, d, d, h] },
  { o: [1, 1, 1], u: [0, 0, -2], v: [0, -2, 0], n: [1, 0, 0], rect: (w, h, d) => [d + w, d, d, h] },
  { o: [-1, 1, -1], u: [2, 0, 0], v: [0, 0, 2], n: [0, 1, 0], rect: (w, _, d) => [d, 0, w, d] },
  { o: [-1, -1, 1], u: [2, 0, 0], v: [0, 0, -2], n: [0, -1, 0], rect: (w, _, d) => [d + w, 0, w, d] },
]

// 镜头空间的法线到明暗：顶面 1，朝着相机的正面 0.9，看得到的侧面 0.72，底面 0.4（相机空间的固定光源，两个视角一样亮）
function shadeOf(nx: number, ny: number, nz: number): number {
  return Math.max(0.4, Math.min(1, 0.7 + 0.08 * nx + 0.23 * ny + 0.27 * nz))
}

const EPSILON = 1e-9

function rasterize(
  out: Rgba,
  depth: Float64Array,
  frameX: number,
  frameWidth: number,
  skin: Rgba,
  s: number,
  face: Face,
  overlay: boolean,
  scratch: Uint8Array,
): void {
  const { ox, oy, ux, uy, vx, vy, oz, uz, vz, tx, ty, tw, th, shade } = face
  const det = ux * vy - uy * vx
  if (Math.abs(det) < EPSILON) return
  const x0 = Math.max(0, Math.floor(Math.min(ox, ox + ux, ox + vx, ox + ux + vx))),
    x1 = Math.min(frameWidth - 1, Math.ceil(Math.max(ox, ox + ux, ox + vx, ox + ux + vx))),
    y0 = Math.max(0, Math.floor(Math.min(oy, oy + uy, oy + vy, oy + uy + vy))),
    y1 = Math.min(out.height - 1, Math.ceil(Math.max(oy, oy + uy, oy + vy, oy + uy + vy)))
  const left = tx * s,
    top = ty * s,
    right = (tx + tw) * s - 1,
    bottom = (ty + th) * s - 1
  for (let py = y0; py <= y1; py++) {
    const dy = py + 0.5 - oy
    for (let px = x0; px <= x1; px++) {
      const dx = px + 0.5 - ox
      const a = (dx * vy - dy * vx) / det,
        c = (ux * dy - uy * dx) / det
      if (a < -EPSILON || a > 1 + EPSILON || c < -EPSILON || c > 1 + EPSILON) continue
      const z = oz + a * uz + c * vz
      const i = py * frameWidth + px
      if (z <= depth[i]!) continue
      const sx = Math.max(left, Math.min(right, Math.floor((tx + a * tw) * s))),
        sy = Math.max(top, Math.min(bottom, Math.floor((ty + c * th) * s)))
      const q = (sy * skin.width + sx) * 4
      const alpha = skin.data[q + 3]!
      if (alpha === 0) continue
      const p = (py * out.width + frameX + px) * 4
      if (!overlay || alpha === 255) {
        depth[i] = z
        out.data[p] = Math.trunc(skin.data[q]! * shade + 0.5)
        out.data[p + 1] = Math.trunc(skin.data[q + 1]! * shade + 0.5)
        out.data[p + 2] = Math.trunc(skin.data[q + 2]! * shade + 0.5)
        out.data[p + 3] = 255
      } else {
        // 半透明的外层按从远到近的顺序叠上去，不写深度
        scratch[0] = Math.trunc(skin.data[q]! * shade + 0.5)
        scratch[1] = Math.trunc(skin.data[q + 1]! * shade + 0.5)
        scratch[2] = Math.trunc(skin.data[q + 2]! * shade + 0.5)
        scratch[3] = alpha
        over(out.data, p, scratch, 0)
      }
    }
  }
}

type Figure = Placement['figures'][number]

// 把一个人物在某一帧里朝向相机的面投到帧里（输出像素）。outer 为 null 时只取内层
function collectFaces(slim: boolean, frame: number, figure: Figure, p: number, base: Face[], outer: Face[] | null) {
  const world = [0, 0, 0],
    screen = [0, 0, 0, 0, 0, 0, 0, 0, 0],
    normal = [0, 0],
    camera = [0, 0, 0]
  for (const part of parts(slim)) {
    const [w, h, d, , , bu, bv, ou, ov, inflate] = part
    for (const layer of outer ? [0, 1] : [0]) {
      const i = layer ? inflate : 0
      const hx = w / 2 + i,
        hy = h / 2 + i,
        hz = d / 2 + i
      for (const face of FACES) {
        const { o, u, v, n } = face
        rotateNormal(part, frame, n[0], n[1], normal)
        toScreen(normal[0]!, normal[1]!, n[2], figure.yaw, camera, 0)
        // 背对相机的面不画（screen 的 y 朝下，所以朝上的分量取负）
        if (camera[2]! <= EPSILON) continue
        toWorld(part, frame, o[0] * hx, o[1] * hy, o[2] * hz, world)
        toScreen(world[0]!, world[1]!, world[2]!, figure.yaw, screen, 0)
        toWorld(part, frame, (o[0] + u[0]) * hx, (o[1] + u[1]) * hy, (o[2] + u[2]) * hz, world)
        toScreen(world[0]!, world[1]!, world[2]!, figure.yaw, screen, 3)
        toWorld(part, frame, (o[0] + v[0]) * hx, (o[1] + v[1]) * hy, (o[2] + v[2]) * hz, world)
        toScreen(world[0]!, world[1]!, world[2]!, figure.yaw, screen, 6)
        const [rx, ry, rw, rh] = face.rect(w, h, d)
        const ox = (screen[0]! + figure.x) * p,
          oy = (screen[1]! + figure.y) * p
        ;(layer ? outer! : base).push({
          ox,
          oy,
          ux: (screen[3]! + figure.x) * p - ox,
          uy: (screen[4]! + figure.y) * p - oy,
          vx: (screen[6]! + figure.x) * p - ox,
          vy: (screen[7]! + figure.y) * p - oy,
          oz: screen[2]!,
          uz: screen[5]! - screen[2]!,
          vz: screen[8]! - screen[2]!,
          tx: (layer ? ou : bu) + rx,
          ty: (layer ? ov : bv) + ry,
          tw: rw,
          th: rh,
          shade: shadeOf(camera[0]!, -camera[1]!, camera[2]!),
          depth: screen[2]! + (screen[5]! - screen[2]! + screen[8]! - screen[2]!) / 2,
        })
      }
    }
  }
}

/**
 * 皮肤的 3D 出图（BS 皮肤库那样的等轴视角）：内层和外层都是立体的盒子，外层膨胀一点盖在内层上，按面的朝向分明暗。
 * raise 为 true 时出抬手拼图，RAISE_FRAMES 帧从左到右排开，第 0 帧和静止图逐像素相同。
 * type 决定手臂宽度，不重新推断模型；披风没有 3D 出图，用 renderFigure
 */
export function renderPose(image: Rgba, type: 'steve' | 'alex', view: PoseView, p: number, raise: boolean): Rgba {
  textureScale(type, image.width, image.height)
  checkDensity(p)
  const skin = prepareSkin(image)
  const s = skin.width / 64
  const layout = place(view)
  const frameWidth = layout.width * p,
    frames = raise ? RAISE_FRAMES : 1
  const { width, height } = poseSize(view, p, raise)
  const out: Rgba = { width, height, data: new Uint8Array(width * height * 4) }
  const depth = new Float64Array(frameWidth * height)
  const scratch = new Uint8Array(4)
  for (let frame = 0; frame < frames; frame++) {
    depth.fill(-Infinity)
    for (const figure of layout.figures) {
      const base: Face[] = [],
        outer: Face[] = []
      collectFaces(type === 'alex', frame, figure, p, base, outer)
      for (const face of base) rasterize(out, depth, frame * frameWidth, frameWidth, skin, s, face, false, scratch)
      outer.sort((a, b) => a.depth - b.depth)
      for (const face of outer) rasterize(out, depth, frame * frameWidth, frameWidth, skin, s, face, true, scratch)
    }
  }
  return out
}

/** 剪影的一个面：帧坐标（标准像素）里的四个顶点 x0 y0 … x3 y3，和明暗（顶面 1，越暗越小） */
export interface PoseSilhouetteFace {
  readonly points: readonly number[]
  readonly shade: number
}

/** 站着的经典模型内层朝向相机的面，从远到近排好，给还没有皮肤时的人形剪影用（FigurePlaceholder） */
export function poseSilhouette(view: PoseView): PoseSilhouetteFace[] {
  const faces: Face[] = []
  for (const figure of place(view).figures) collectFaces(false, 0, figure, 1, faces, null)
  return faces
    .sort((a, b) => a.depth - b.depth)
    .map(({ ox, oy, ux, uy, vx, vy, shade }) => ({
      points: [ox, oy, ox + ux, oy + uy, ox + ux + vx, oy + uy + vy, ox + vx, oy + vy],
      shade,
    }))
}
