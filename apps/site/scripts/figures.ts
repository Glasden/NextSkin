// 画面里的出图、hash、PNG 块都由仓库里的代码现算，不手画（ADR-0055）：
// - 皮肤的 3D 出图用 packages/skin 的 renderPose。画面按设备像素的整数倍缩放，大图要按 2 倍出，出图密度会超过产品的上限 16，
//   所以复制一份 pose.ts、放宽上限，再附上一个只画前 k 个面、顺带导出深度缓冲的函数，用来展示光栅化的过程。算法一个字不改
// - 同一组像素的几种编码、它们的文件 hash 和像素 hash，用 packages/domain 的编码器和 pixelHash
// - 一个带附加块的 PNG 和一个解压炸弹，交给 packages/domain 的 decodeTexturePng 实际跑一遍
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'
import {
  decodeTexturePng,
  encodeRenderPng,
  encodeTexturePng,
  pixelHash,
} from '../../../packages/domain/src/textures/image.ts'
import { normalizeTexture, type Rgba } from '../../../packages/skin/src/index.ts'
import { parsePng } from '../../../packages/skin/src/png.ts'
import { DEPTH_DENSITY, poseImages, RASTER_DENSITY, RASTER_STEPS } from '../src/stage/figures.ts'

const repo = join(import.meta.dirname, '../../..')
const skinSrc = join(repo, 'packages/skin/src')

/** 把 search 换成 replace，找不到就报错：pose.ts 改了写法时要跟着改这里，不能悄悄生成一份没放宽的 */
function patch(source: string, search: string, replace: string) {
  if (!source.includes(search)) throw new Error(`pose.ts 里找不到 ${search}`)
  return source.replace(search, replace)
}

/**
 * 放宽出图密度上限的 pose.ts，外加 renderPoseSteps 和 place 的导出。写到系统临时目录：Node 不剥离 node_modules 里的类型。
 * 导入的路径都换成 file: URL：Windows 的绝对路径不是合法的说明符，写进字符串里反斜杠还会被当成转义。
 * 扩展名用 .mts：临时目录往上可能有不写 type 的 package.json，Node 会先当 CommonJS 解析再报警告
 */
async function loadPose() {
  let source = readFileSync(join(skinSrc, 'pose.ts'), 'utf8')
  source = patch(source, "from './composite.ts'", `from '${pathToFileURL(join(skinSrc, 'composite.ts')).href}'`)
  source = patch(source, "from './index.ts'", `from '${pathToFileURL(join(skinSrc, 'index.ts')).href}'`)
  source = patch(source, 'export const MAX_POSE_DENSITY = 16', 'export const MAX_POSE_DENSITY = 48')
  const extra = `
/** 和 renderPose 同样的顺序画面（每个人物先内层、再按远近排好的外层），只画前 faces 个，顺带导出深度缓冲 */
export function renderPoseSteps(image: Rgba, type: 'steve' | 'alex', view: PoseView, p: number, faces: number) {
  const skin = prepareSkin(image)
  const s = skin.width / 64
  const layout = place(view)
  const frameWidth = layout.width * p
  const { width, height } = poseSize(view, p, false)
  const out: Rgba = { width, height, data: new Uint8Array(width * height * 4) }
  const depth = new Float64Array(frameWidth * height).fill(-Infinity)
  const scratch = new Uint8Array(4)
  const all: [Face, boolean][] = []
  for (const figure of layout.figures) {
    const base: Face[] = [], outer: Face[] = []
    collectFaces(type === 'alex', 0, figure, p, base, outer)
    outer.sort((a, b) => a.depth - b.depth)
    all.push(...base.map((f): [Face, boolean] => [f, false]), ...outer.map((f): [Face, boolean] => [f, true]))
  }
  for (const [face, overlay] of all.slice(0, faces)) rasterize(out, depth, 0, frameWidth, skin, s, face, overlay, scratch)
  return { color: out, depth, total: all.length }
}
export { place as placeForSite }
`
  const dir = mkdtempSync(join(tmpdir(), 'nextskin-site-'))
  try {
    const file = join(dir, 'pose-hd.mts')
    writeFileSync(file, `// 由 apps/site/scripts/figures.ts 从 packages/skin/src/pose.ts 生成\n${source}\n${extra}`)
    return (await import(pathToFileURL(file).href)) as {
      renderPose: (image: Rgba, type: 'steve' | 'alex', view: 'front' | 'both', p: number, raise: boolean) => Rgba
      renderPoseSteps: (
        image: Rgba,
        type: 'steve' | 'alex',
        view: 'front' | 'both',
        p: number,
        faces: number,
      ) => { color: Rgba; depth: Float64Array; total: number }
      placeForSite: (view: 'front' | 'both') => {
        width: number
        height: number
        box?: unknown
        figures: { x: number; y: number }[]
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

function chunk(type: string, data: Uint8Array = new Uint8Array()) {
  const bytes = Buffer.alloc(data.length + 12)
  bytes.writeUInt32BE(data.length, 0)
  bytes.write(type, 4, 'latin1')
  bytes.set(data, 8)
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), data.length + 8)
  return bytes
}

/** 每行都用同一种滤波的 PNG 编码（0 None、1 Sub、2 Up、3 Average、4 Paeth） */
function encodeWith(image: Rgba, filter: number, level: number, extra: { before?: Buffer[]; after?: Buffer[] } = {}) {
  const { width, height, data } = image
  const stride = width * 4
  const raw = new Uint8Array((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = filter
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x
      const a = x >= 4 ? data[i - 4]! : 0
      const b = y ? data[i - stride]! : 0
      const c = y && x >= 4 ? data[i - stride - 4]! : 0
      const p = a + b - c
      const pa = Math.abs(p - a),
        pb = Math.abs(p - b),
        pc = Math.abs(p - c)
      const pred = [0, a, b, (a + b) >>> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter]!
      raw[y * (stride + 1) + 1 + x] = (data[i]! - pred) & 255
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const idat = deflateSync(raw, { level })
  // 大的 IDAT 拆成两块，和常见的编辑器一样
  const half = Math.ceil(idat.length / 2)
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    ...(extra.before ?? []),
    ...(extra.after
      ? [chunk('IDAT', idat.subarray(0, half)), chunk('IDAT', idat.subarray(half))]
      : [chunk('IDAT', idat)]),
    ...(extra.after ?? []),
    chunk('IEND'),
  ])
}

function grayDepth(depth: Float64Array, width: number, height: number): Rgba {
  let min = Infinity,
    max = -Infinity
  for (const z of depth) {
    if (z === -Infinity) continue
    min = Math.min(min, z)
    max = Math.max(max, z)
  }
  const out: Rgba = { width, height, data: new Uint8Array(width * height * 4) }
  for (let i = 0; i < depth.length; i++) {
    const z = depth[i]!
    if (z === -Infinity) continue
    // 近处亮、远处暗，按 4 档量化成色带，像素画风格
    const v = Math.round(((z - min) / (max - min || 1)) * 7) / 7
    const g = Math.round(70 + v * 185)
    out.data.set([g, g, g, 255], i * 4)
  }
  return out
}

export async function generateFigures(out: string) {
  mkdirSync(out, { recursive: true })
  const pose = await loadPose()
  const original = readFileSync(join(repo, 'packages/skin/assets/default-skin.png'))
  const skin = normalizeTexture(decodeTexturePng(original), 'alex')
  // 每张图出 1 倍和 2 倍两份：画面上一个排版像素是 1 个还是 2 个以上的设备像素（PoseImage 按 useDensity 选）。
  // 文件名不用 @：Workers 的静态资源会把 @ 307 跳转到 %40
  const save = (name: string, render: (scale: number) => Rgba) => {
    for (const scale of [1, 2]) writeFileSync(join(out, `${name}.${scale}x.png`), encodeRenderPng(render(scale)))
  }

  for (const image of poseImages) {
    save(image.name, (scale) =>
      pose.renderPose(skin, 'alex', image.view, image.density * scale, 'raise' in image && image.raise),
    )
  }

  // 光栅化的过程：每一步多画几个面，旁边是深度缓冲
  const { total } = pose.renderPoseSteps(skin, 'alex', 'front', 1, 0)
  const faceCounts: number[] = []
  for (let i = 1; i <= RASTER_STEPS; i++) {
    const faces = Math.round((total * i) / RASTER_STEPS)
    faceCounts.push(faces)
    save(`raster-${i}`, (scale) => pose.renderPoseSteps(skin, 'alex', 'front', RASTER_DENSITY * scale, faces).color)
    save(`depth-${i}`, (scale) => {
      const { color, depth } = pose.renderPoseSteps(skin, 'alex', 'front', DEPTH_DENSITY * scale, faces)
      return grayDepth(depth, color.width, color.height)
    })
  }
  const front = pose.placeForSite('front')
  const both = pose.placeForSite('both')
  // 抬手拼图和静止图在材质卡片 2x 屏上（p = 8）的体积：调色板 PNG 对比 RGBA 编码
  const card = pose.renderPose(skin, 'alex', 'both', 8, false)

  // 同一组像素的九种文件：原文件、产品的存储编码、调色板，加上六种手工参数
  const hash = pixelHash(skin)
  const encodings = [
    { label: '原文件', en: 'as uploaded', bytes: original },
    { label: '存储编码 · 自适应 · zlib 6', en: 'stored', bytes: encodeTexturePng(skin) },
    { label: '调色板 · zlib 9', en: 'palette', bytes: encodeRenderPng(skin) },
    ...[
      [0, 9, 'None'],
      [1, 9, 'Sub'],
      [2, 9, 'Up'],
      [3, 9, 'Average'],
      [4, 9, 'Paeth'],
      [0, 1, 'None'],
    ].map(([filter, level, name]) => ({
      label: `滤波 ${name} · zlib ${level}`,
      en: 'manual',
      bytes: encodeWith(skin, filter as number, level as number),
    })),
  ].map((e) => {
    const decoded = normalizeTexture(decodeTexturePng(e.bytes), 'alex')
    if (pixelHash(decoded) !== hash) throw new Error(`${e.label} 解出来的像素不同`)
    return { label: e.label, size: e.bytes.length, fileHash: sha(e.bytes) }
  })
  if (new Set(encodings.map((e) => e.fileHash)).size !== encodings.length) throw new Error('文件 hash 有重复')

  // 一个编辑器导出的 PNG：带色彩配置、分辨率、文字、时间这些附加块，IDAT 拆成两块
  const text = (s: string) => Buffer.from(s, 'latin1')
  const upload = encodeWith(skin, 4, 9, {
    before: [
      chunk('iCCP', Buffer.concat([text('sRGB\0\0'), deflateSync(Buffer.alloc(480, 7))])),
      chunk('pHYs', Buffer.from([0, 0, 11, 19, 0, 0, 11, 19, 1])),
      chunk('tEXt', text('Software\0Paint')),
    ],
    after: [chunk('tIME', Buffer.from([7, 234, 10, 21, 12, 0, 0]))],
  })
  const parsed = parsePng(upload, { maxWidth: 1024, maxHeight: 1024, maxInflatedBytes: 9 * 1024 * 1024 })
  const chunks: { type: string; length: number; crc: string }[] = []
  for (let offset = 8; offset < upload.length;) {
    const length = upload.readUInt32BE(offset)
    chunks.push({
      type: upload.toString('latin1', offset + 4, offset + 8),
      length,
      crc: upload
        .readUInt32BE(offset + 8 + length)
        .toString(16)
        .padStart(8, '0'),
    })
    offset += length + 12
  }
  // 解压炸弹：IHDR 照样写 64×64，IDAT 却能解出 64 MiB
  const bombRaw = Buffer.alloc(64 * 1024 * 1024)
  const bomb = Buffer.concat([upload.subarray(0, 33), chunk('IDAT', deflateSync(bombRaw, { level: 9 })), chunk('IEND')])
  let bombError = ''
  try {
    decodeTexturePng(bomb)
  } catch (error) {
    bombError = (error as Error).message
  }
  if (!bombError) throw new Error('解压炸弹没有被拒绝')

  // 脸部 8×8 的颜色，画面上像素流用
  const pixelStrip: string[] = []
  for (let y = 8; y < 16; y++)
    for (let x = 8; x < 16; x++) {
      const i = (y * skin.width + x) * 4
      pixelStrip.push(`#${[0, 1, 2].map((k) => skin.data[i + k]!.toString(16).padStart(2, '0')).join('')}`)
    }

  // 明暗的色块：脸上最多的那个颜色（肤色）乘上 pose.ts 的三档明暗，取整和 rasterize 一样
  const counts = new Map<string, number>()
  for (const color of pixelStrip) counts.set(color, (counts.get(color) ?? 0) + 1)
  const base = [...counts].sort((a, b) => b[1] - a[1])[0]![0]
  const swatches = [1, 0.9, 0.72].map((shade) => ({
    shade,
    color: `#${[1, 3, 5]
      .map((k) =>
        Math.trunc(Number.parseInt(base.slice(k, k + 2), 16) * shade + 0.5)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')}`,
  }))

  return {
    pixelHash: hash,
    pixelStrip,
    encodings,
    pose: {
      front: { width: front.width, height: front.height, x: front.figures[0]!.x, y: front.figures[0]!.y },
      both: { width: both.width, height: both.height, box: both.box },
      faces: total,
      faceCounts,
      cardRgba: encodeTexturePng(card).length,
      cardPalette: encodeRenderPng(card).length,
      swatches,
    },
    png: {
      chunks,
      expectedInflatedBytes: parsed.expectedInflatedBytes,
      bombFile: bomb.length,
      bombInflated: bombRaw.length,
      bombError,
    },
  }
}
