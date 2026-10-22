import { cx } from '@nextskin/ui'
import type { CSSProperties, ReactNode } from 'react'
import repoData from '../gen/repo-data.json'
import { DEPTH_DENSITY, RASTER_DENSITY } from '../stage/figures.ts'
import { POSE, PoseImage } from '../stage/skin.tsx'
import { BEAT, barsFrom, EIGHTH, enter, SIXTEENTH, steps, useDensity, useT } from '../stage/time.ts'
import { abs, icons, Mono, PixelIcon, Px, Scene, Stage, Title } from '../stage/ui.tsx'
import { PART_COUNT, type ShadeClass, Wireframe, YAW } from '../stage/wireframe.tsx'
import type { Page } from './page.ts'

const at = barsFrom(25)

const { faces, faceCounts, cardRgba, cardPalette, swatches } = repoData.pose

// 四列流水线：一小节一列，前一列做完，下一列接着做
const COL = 270
const GAP = 24
const colX = (i: number) => 64 + i * (COL + GAP)
const HEAD = 208
const STAGE = { y: 248, h: 312 }
const CAPTION = 576
const D = RASTER_DENSITY
const FRONT = { x: (COL - POSE.front.width * D) / 2, y: (STAGE.h - POSE.front.height * D) / 2 }
const RAISE_D = 4
const RAISE = { x: (COL - POSE.both.width * RAISE_D) / 2, y: (STAGE.h - POSE.both.height * RAISE_D) / 2 }

const columns = [
  { zh: '盒子和投影', en: 'BOXES', start: at(25) },
  { zh: '光栅化', en: 'RASTERIZE', start: at(26) },
  { zh: '明暗', en: 'SHADING', start: at(27) },
  { zh: '抬手', en: 'SPRITE', start: at(28) },
]

// pose.ts 的 shadeOf：相机空间的固定光源，看得见的三档
const shades: { cls: ShadeClass; zh: string }[] = [
  { cls: 'top', zh: '顶面' },
  { cls: 'front', zh: '正面' },
  { cls: 'side', zh: '侧面' },
]

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`

/**
 * 皮肤的 3D 出图怎么来的，每一步都是 packages/skin 的 renderPose 实际算出来的：
 * 线框转到相机角度锁定；面一个个光栅化，旁边是深度缓冲；三档明暗；抬手拼图和调色板 PNG 的体积
 */
function Raster() {
  const t = useT()
  // 线框转三拍，每八分音符一格，第 4 拍锁到 30°
  const spin = steps(t, at(25), 3 * BEAT, 6)
  const yaw = YAW + (1 - spin) * Math.PI * 1.5
  const inner = Math.max(0, Math.min(PART_COUNT, Math.floor((t - at(25)) / SIXTEENTH) + 1))
  const outer = t < at(25, 3) ? 0 : Math.min(PART_COUNT, Math.floor((t - at(25, 3)) / SIXTEENTH) + 1)
  const step = Math.max(1, Math.min(faceCounts.length, Math.floor((t - at(26)) / SIXTEENTH) + 1))
  const shade = t >= at(27) && t < at(27, 4) ? shades[Math.floor((t - at(27)) / BEAT)]?.cls : undefined
  const frame = Math.max(0, Math.min(4, Math.floor((t - at(28)) / EIGHTH)))

  return (
    <Scene>
      <Title
        zh="皮肤图是服务端用纯 TS 一个个像素画出来的"
        en="Skin renders are rasterized on the server, in pure TypeScript"
      />
      {columns.map((col, i) => {
        const on = t >= col.start
        const now = on && (i === columns.length - 1 || t < columns[i + 1]!.start)
        return (
          <div key={col.zh}>
            <div className="flex items-baseline" style={abs(colX(i), HEAD, { gap: 10 })}>
              <Px size={24} tone={on ? 'accent' : 'muted'}>
                {String(i + 1).padStart(2, '0')}
              </Px>
              <Px size={24} tone={on ? 'text' : 'muted'}>
                {col.zh}
              </Px>
              <Px size={12} tone="muted">
                {col.en}
              </Px>
            </div>
            <div
              className={cx(
                'rounded-md',
                now ? 'border-2 border-accent' : 'border border-border',
                !on && 'border-dashed',
              )}
              style={abs(colX(i) - (now ? 1 : 0), STAGE.y - (now ? 1 : 0), {
                width: COL + (now ? 2 : 0),
                height: STAGE.h + (now ? 2 : 0),
              })}
            />
            {i < columns.length - 1 && (
              <div style={abs(colX(i) + COL + 4, STAGE.y + STAGE.h / 2 - 6)}>
                <PixelIcon rows={icons.arrow} cell={2} tone={t >= columns[i + 1]!.start ? 'accent' : 'muted'} />
              </div>
            )}
          </div>
        )
      })}

      <Column i={0}>
        <Wireframe density={D} yaw={yaw} parts={inner} outer={outer} style={{ left: FRONT.x, top: FRONT.y }} />
      </Column>
      <Caption i={0}>
        <Px size={24}>6 个盒子，外层膨胀</Px>
        <Mono size={13} tone="muted">
          相机转 30°、俯视 18°，正交投影
        </Mono>
      </Caption>

      <Column i={1}>
        <Figure src={`raster-${step}`} density={D} style={abs(FRONT.x, FRONT.y)} />
        <Wireframe
          density={D}
          parts={0}
          outer={PART_COUNT}
          style={{ left: FRONT.x, top: FRONT.y, opacity: step === faceCounts.length ? 0 : 0.5 }}
        />
      </Column>
      <Caption i={1}>
        <div className="flex items-end" style={{ gap: 16 }}>
          <div className="bg-surface-sunken" style={{ padding: 4 }}>
            <Figure src={`depth-${step}`} density={DEPTH_DENSITY} />
          </div>
          <div>
            <Px size={12} tone="muted">
              面 FACES
            </Px>
            <Px size={36}>
              {String(faceCounts[step - 1]).padStart(2, '0')}
              <span className="text-text-muted" style={{ fontSize: 24 }}>
                {' '}
                / {faces}
              </span>
            </Px>
            <Px size={12} tone="muted">
              左边是深度缓冲 · DEPTH
            </Px>
          </div>
        </div>
      </Caption>

      <Column i={2}>
        <PoseImage name="front-d8" view="front" density={D} style={abs(FRONT.x, FRONT.y)} />
        <Wireframe density={D} parts={0} highlight={shade} style={{ left: FRONT.x, top: FRONT.y }} />
      </Column>
      <Caption i={2}>
        <div className="flex" style={{ gap: 8 }}>
          {shades.map((s, k) => (
            <div
              key={s.cls}
              className={cx('flex-1 bg-surface', s.cls === shade ? 'border-2 border-accent' : 'border border-border')}
              style={{ padding: '4px 6px' }}
            >
              {/* 色块是材质自己的肤色乘上这一档明暗（scripts/figures.ts） */}
              <svg aria-hidden width="100%" height={14} className="block">
                <rect width="100%" height={14} fill={swatches[k]!.color} />
              </svg>
              <Px size={12}>{s.zh}</Px>
              <Mono size={13} tone={s.cls === shade ? 'accent' : 'muted'}>
                × {swatches[k]!.shade.toFixed(2)}
              </Mono>
            </div>
          ))}
        </div>
      </Caption>

      <Column i={3}>
        <PoseImage
          name="both-raise-d4"
          view="both"
          density={RAISE_D}
          frames={5}
          frame={frame}
          style={abs(RAISE.x, RAISE.y)}
        />
        <div className="flex justify-center" style={abs(0, STAGE.h - 34, { width: COL, gap: 6 })}>
          {[0, 1, 2, 3, 4].map((f) => (
            <div key={f} className={f <= frame ? 'bg-accent' : 'bg-border'} style={{ width: 24, height: 8 }} />
          ))}
        </div>
      </Column>
      <Caption i={3}>
        <div style={enter(t, at(28, 3))}>
          <SizeBar label="RGBA" bytes={cardRgba} />
          <SizeBar label="调色板" bytes={cardPalette} grow={steps(t, at(28, 3), EIGHTH, 4)} accent />
          <Px size={12} tone="accent" style={{ marginTop: 4 }}>
            调色板 PNG 小 {Math.round((1 - cardPalette / cardRgba) * 100)}%
          </Px>
        </div>
      </Caption>
    </Scene>
  )
}

/** 一列的展台：到这一列开始时才出现内容 */
function Column({ i, children }: { i: number; children: ReactNode }) {
  const t = useT()
  if (t < columns[i]!.start) return null
  return (
    <Stage style={abs(colX(i), STAGE.y, { width: COL, height: STAGE.h, ...enter(t, columns[i]!.start, 0) })}>
      {children}
    </Stage>
  )
}

function Caption({ i, children }: { i: number; children: ReactNode }) {
  const t = useT()
  return <div style={abs(colX(i), CAPTION, { width: COL, ...enter(t, columns[i]!.start + EIGHTH, 8) })}>{children}</div>
}

/** 生成脚本按 1 倍和 2 倍出的过程图（scripts/figures.ts），宽高取正面的版式 */
function Figure({ src, density, style }: { src: string; density: number; style?: CSSProperties }) {
  const scale = useDensity() >= 2 ? 2 : 1
  return (
    <img
      src={`/gen/pose/${src}.${scale}x.png`}
      alt=""
      className="pixelated block max-w-none"
      style={{ width: POSE.front.width * density, height: POSE.front.height * density, ...style }}
    />
  )
}

function SizeBar({
  label,
  bytes,
  grow = 1,
  accent = false,
}: {
  label: string
  bytes: number
  grow?: number
  accent?: boolean
}) {
  return (
    <div className="flex items-center" style={{ gap: 8, height: 22 }}>
      <Px size={12} tone="muted" style={{ width: 40 }}>
        {label}
      </Px>
      <div
        className={accent ? 'bg-accent' : 'bg-text-muted'}
        style={{ width: Math.round(150 * (bytes / cardRgba) * grow), height: 12 }}
      />
      <Mono size={13} tone="muted">
        {grow === 1 ? kb(bytes) : ''}
      </Mono>
    </div>
  )
}

export const raster: Page = {
  id: 'raster',
  Scene: Raster,
  duration: at(29) + SIXTEENTH,
  hold: 6,
  chapter: { no: '08', zh: '出图', en: 'RENDERING' },
  text: {
    title: '皮肤图是服务端用纯 TS 一个个像素画出来的',
    en: 'Skin renders are rasterized on the server, in pure TypeScript',
    body: [
      '皮肤库和衣柜里的人物图不用 WebGL，也不用原生的图形库：`packages/skin` 把六个部位当成盒子，相机转 30°、俯视 18° 正交投影，再逐个面光栅化，深度缓冲决定谁挡住谁。',
      '明暗是相机空间的固定光源，顶面、正面、侧面三档。三角函数写成字面量，因为各个 JS 引擎的 `Math.cos` 不保证逐位相同，出图要和黄金图逐像素比对。',
      '鼠标悬浮时人物抬手，用的是 5 帧的拼图。颜色不到 256 种的图存成调色板 PNG，比 RGBA 编码小得多。',
    ],
  },
}
