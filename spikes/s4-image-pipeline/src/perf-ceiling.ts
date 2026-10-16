/**
 * 主会话补充的实验：渲染慢是实现问题，还是纯 TS 的上限？
 *
 * render.ts 的光栅器和缩放在热循环里逐像素分配（subarray、颜色元组、片元对象、每像素数组）。
 * 这里用同样的算术和同样的合成顺序重写成无分配版本：
 * - 片元用类型化数组组成的链表存储，按插入顺序追加，合成前对每个像素做稳定的插入排序；
 * - 逆映射、深度测试、取整与 render.ts 逐项相同，输出必须逐像素一致。
 *
 *   npx tsx src/perf-ceiling.ts
 */
import { readFileSync } from 'node:fs'
import { Bench } from 'tinybench'
import { decode, encodePng, type Image } from './png.ts'
import { CAMERA, type Box, avatar2d, blank, boxes, over, prepareSkin, rasterize } from './render.ts'

type V = [number, number, number]

function project([x, y, z]: V): V {
  const cy = Math.cos(CAMERA.yaw), sy = Math.sin(CAMERA.yaw), ce = Math.cos(CAMERA.elevation), se = Math.sin(CAMERA.elevation)
  return [x * cy - z * sy, -y * ce + (x * sy + z * cy) * se, y * se + (x * sy + z * cy) * ce]
}

interface Face { o: V; u: V; v: V; uv: [number, number, number, number]; light: number; overlay: boolean }

/** 与 render.ts 的 faces() 相同的面定义（复制过来，避免依赖其内部函数） */
function faces(b: Box, light: { top: number; front: number; side: number }): Face[] {
  const [w, h, d] = b.size, [cx, cy, cz] = b.position, [tx, ty] = b.uv, e = b.expand
  const x = cx - w / 2 - e, X = cx + w / 2 + e, y = cy - h / 2 - e, Y = cy + h / 2 + e, z = cz - d / 2 - e, Z = cz + d / 2 + e
  const f = (o: V, u: V, v: V, uv: Face['uv'], l: number): Face => ({ o, u, v, uv, light: l, overlay: b.overlay })
  return [
    f([x, Y, z], [X - x, 0, 0], [0, 0, Z - z], [tx + d, ty, w, d], light.top),
    f([x, Y, Z], [X - x, 0, 0], [0, y - Y, 0], [tx + d, ty + d, w, h], light.front),
    f([X, Y, Z], [0, 0, z - Z], [0, y - Y, 0], [tx + d + w, ty + d, d, h], light.side),
    f([x, Y, z], [0, 0, Z - z], [0, y - Y, 0], [tx, ty + d, d, h], light.side),
    f([X, Y, z], [x - X, 0, 0], [0, y - Y, 0], [tx + w + 2 * d, ty + d, w, h], light.front),
    f([x, y, Z], [X - x, 0, 0], [0, 0, z - Z], [tx + d + w, ty, w, d], light.side),
  ]
}

export function rasterizeFast(texture: Image, items: Box[], width: number, height: number, light = { top: 1, front: 0.85, side: 0.7 }): Image {
  const fs = items.flatMap((b) => faces(b, light))
  const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
  const verts = fs.flatMap((f) => [f.o, add(f.o, f.u), add(f.o, f.v), add(add(f.o, f.u), f.v)].map(project))
  const minX = Math.min(...verts.map((v) => v[0])), maxX = Math.max(...verts.map((v) => v[0]))
  const minY = Math.min(...verts.map((v) => v[1])), maxY = Math.max(...verts.map((v) => v[1]))
  const scale = Math.min((width - CAMERA.margin * 2) / (maxX - minX), (height - CAMERA.margin * 2) / (maxY - minY))
  const ox = (width - (maxX - minX) * scale) / 2 - minX * scale, oy = (height - (maxY - minY) * scale) / 2 - minY * scale

  const out = blank(width, height), px = out.data, tex = texture.data, tw = texture.width, k = texture.width / 64
  const depth = new Float64Array(width * height).fill(-Infinity)
  // 半透明片元链表：head/tail 按像素，next/z/color/light 按片元
  const head = new Int32Array(width * height).fill(-1), tail = new Int32Array(width * height).fill(-1)
  let cap = 1 << 16, n = 0
  let fz = new Float64Array(cap), fc = new Uint32Array(cap), fl = new Float64Array(cap), fnext = new Int32Array(cap)
  const grow = () => {
    cap *= 2
    const z2 = new Float64Array(cap); z2.set(fz); fz = z2
    const c2 = new Uint32Array(cap); c2.set(fc); fc = c2
    const l2 = new Float64Array(cap); l2.set(fl); fl = l2
    const n2 = new Int32Array(cap); n2.set(fnext); fnext = n2
  }

  const draw = (f: Face) => {
    const o = project(f.o), pu = project(f.u), pv = project(f.v), det = pu[0] * pv[1] - pv[0] * pu[1]
    if (Math.abs(det) < 1e-9) return
    const cs = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => [ox + (o[0] + u! * pu[0] + v! * pv[0]) * scale, oy + (o[1] + u! * pu[1] + v! * pv[1]) * scale])
    const x0 = Math.max(0, Math.floor(Math.min(...cs.map((p) => p[0]!)))), x1 = Math.min(width, Math.ceil(Math.max(...cs.map((p) => p[0]!))))
    const y0 = Math.max(0, Math.floor(Math.min(...cs.map((p) => p[1]!)))), y1 = Math.min(height, Math.ceil(Math.max(...cs.map((p) => p[1]!))))
    const [u0, v0, uw, vh] = f.uv
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const rx = (x + 0.5 - ox) / scale - o[0], ry = (y + 0.5 - oy) / scale - o[1]
        const u = (rx * pv[1] - ry * pv[0]) / det, v = (pu[0] * ry - pu[1] * rx) / det
        if (u < 0 || u >= 1 || v < 0 || v >= 1) continue
        const z = o[2] + pu[2] * u + pv[2] * v, p = y * width + x
        if (z < depth[p]! - 1e-8) continue
        const q = (Math.floor((v0 + v * vh) * k) * tw + Math.floor((u0 + u * uw) * k)) * 4
        const a = tex[q + 3]!
        if (!a) continue
        if (f.overlay) {
          if (n === cap) grow()
          fz[n] = z; fl[n] = f.light; fnext[n] = -1
          fc[n] = (tex[q]! | (tex[q + 1]! << 8) | (tex[q + 2]! << 16) | (a << 24)) >>> 0
          if (head[p] === -1) head[p] = n; else fnext[tail[p]!] = n
          tail[p] = n++
        } else {
          depth[p] = z
          px[p * 4] = Math.round(tex[q]! * f.light); px[p * 4 + 1] = Math.round(tex[q + 1]! * f.light); px[p * 4 + 2] = Math.round(tex[q + 2]! * f.light); px[p * 4 + 3] = 255
        }
      }
    }
  }
  for (const f of fs) if (!f.overlay) draw(f)
  for (const f of fs) if (f.overlay) draw(f)

  // 合成：每个像素的片元按 z 稳定排序（插入排序），由远到近 over
  const idx = new Int32Array(64), rgba = new Uint8Array(4)
  for (let p = 0; p < head.length; p++) {
    let m = 0
    for (let i = head[p]!; i !== -1; i = fnext[i]!) {
      let j = m++
      while (j > 0 && fz[idx[j - 1]!]! > fz[i]!) { idx[j] = idx[j - 1]!; j-- }
      idx[j] = i
    }
    for (let j = 0; j < m; j++) {
      const i = idx[j]!
      if (fz[i]! < depth[p]! - 1e-8) continue
      const c = fc[i]!
      rgba[0] = c & 255; rgba[1] = (c >>> 8) & 255; rgba[2] = (c >>> 16) & 255; rgba[3] = c >>> 24
      over(px, p * 4, rgba, fl[i]!)
    }
  }
  return out
}

/** 最近邻缩放，无分配；取样公式与 render.ts 的 resize() 相同 */
export function resizeFast(i: Image, width: number, height: number): Image {
  const o = blank(width, height), src = new Uint32Array(i.data.buffer, i.data.byteOffset, i.width * i.height), dst = new Uint32Array(o.data.buffer)
  const cols = new Int32Array(width)
  for (let x = 0; x < width; x++) cols[x] = Math.min(i.width - 1, Math.floor(((x + 0.5) * i.width) / width))
  for (let y = 0; y < height; y++) {
    const row = Math.min(i.height - 1, Math.floor(((y + 0.5) * i.height) / height)) * i.width, base = y * width
    for (let x = 0; x < width; x++) dst[base + x] = src[row + cols[x]!]!
  }
  return o
}

function avatar2dFast(skin: Image, size: number): Image {
  const s = prepareSkin(skin), k = s.width / 64, n = 8 * k, face = blank(n, n)
  for (let y = 0; y < n; y++) {
    face.data.set(s.data.subarray(((8 * k + y) * s.width + 8 * k) * 4, ((8 * k + y) * s.width + 16 * k) * 4), y * n * 4)
    for (let x = 0; x < n; x++) {
      const q = ((8 * k + y) * s.width + 40 * k + x) * 4
      over(face.data, (y * n + x) * 4, s.data.subarray(q, q + 4))
    }
  }
  return resizeFast(face, size, size)
}

const same = (a: Image, b: Image) => a.width === b.width && a.height === b.height && Buffer.compare(a.data, b.data) === 0

{
  const skins = ['hatsune_miku', 'ironman_hd', 'sethbling', 'haka', '1_8_texturemap_redux', 'deadmau5', 'hacksore'].map((n) => ({
    n, img: decode(readFileSync(`fixtures/real/${n}.png`)),
  }))
  // 1. 逐像素一致
  let checks = 0
  for (const { n, img } of skins) {
    const p = prepareSkin(img)
    for (const [label, items, w, h] of [
      ['avatar3d', boxes('default', true), 512, 512],
      ['body3d-default', boxes('default'), 384, 512],
      ['body3d-slim', boxes('slim'), 384, 512],
    ] as const) {
      if (!same(rasterize(p, items, w, h), rasterizeFast(p, items, w, h))) throw new Error(`${n} ${label} 不一致`)
      checks++
    }
    for (const size of [64, 128, 512]) {
      if (!same(avatar2d(img, size), avatar2dFast(img, size))) throw new Error(`${n} avatar2d-${size} 不一致`)
      checks++
    }
  }
  console.log(`逐像素一致：${checks}/${checks}`)

  // 2. 只测渲染（不含编码），以及渲染 + PNG 编码
  const miku = skins[0]!.img, prepared = prepareSkin(miku)
  const bench = new Bench({ time: 300, warmupTime: 100 })
  bench
    .add('avatar2d-512 render.ts', () => { avatar2d(miku, 512) })
    .add('avatar2d-512 无分配', () => { avatar2dFast(miku, 512) })
    .add('avatar3d-512 render.ts', () => { rasterize(prepared, boxes('default', true), 512, 512) })
    .add('avatar3d-512 无分配', () => { rasterizeFast(prepared, boxes('default', true), 512, 512) })
    .add('body3d-512 render.ts', () => { rasterize(prepared, boxes('slim'), 384, 512) })
    .add('body3d-512 无分配', () => { rasterizeFast(prepared, boxes('slim'), 384, 512) })
    .add('avatar3d-128 无分配 + PNG', () => { encodePng(rasterizeFast(prepared, boxes('default', true), 128, 128)) })
    .add('avatar3d-512 无分配 + PNG', () => { encodePng(rasterizeFast(prepared, boxes('default', true), 512, 512)) })
  await bench.run()
  console.log(`Node ${process.version}`)
  console.log('| 任务 | 中位数 ms | p99 ms |')
  console.log('|---|---|---|')
  for (const t of bench.tasks) {
    const r = t.result as any
    console.log(`| ${t.name} | ${r.latency.p50.toFixed(2)} | ${r.latency.p99.toFixed(2)} |`)
  }
}
