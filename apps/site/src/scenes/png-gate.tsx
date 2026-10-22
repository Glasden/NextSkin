import { cx } from '@nextskin/ui'
import type { ReactNode } from 'react'
import repoData from '../gen/repo-data.json'
import { BEAT, barsFrom, EIGHTH, enter, SIXTEENTH, steps, useT } from '../stage/time.ts'
import { abs, Mark, Mono, Panel, Px, Scene, Title } from '../stage/ui.tsx'
import type { Page } from './page.ts'

const at = barsFrom(7.5)

const { chunks, expectedInflatedBytes, bombFile, bombInflated, bombError } = repoData.png
// 只把这几种块交给解码，其余的附加块丢掉（ADR-0008）
const KEEP = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'])

const W = 104
const H = 64
const SLOT = W + 12
// 从右往左流：排队的在闸门右边，按文件里的顺序排；过了闸门的在左边，同样按文件顺序排
const GATE = { x: 600, y: 252 }
const LANE = { x: 64, keep: 252, drop: 368 }

const S = at(7, 3)

const fmt = (n: number) => n.toLocaleString('en-US').replace(/,/g, ' ')

/**
 * 一个编辑器导出的 PNG 按块过闸：逐块核对 CRC，关键块往左走，附加块掉进下面。
 * 然后按 IHDR 算出解压长度，正常文件正好填满；解压炸弹在预算处被截住
 */
function PngGate() {
  const t = useT()
  const cur = Math.max(-1, Math.min(chunks.length, Math.floor((t - S) / EIGHTH)))
  // 每个八分音符的头一个十六分音符里分四格挪到下一个位置
  const prog = cur < 0 || cur >= chunks.length + 1 ? 1 : steps(t, S + cur * EIGHTH, SIXTEENTH, 4)
  const kept: number[] = []
  const dropped: number[] = []
  chunks.forEach((ch, i) => (KEEP.has(ch.type) ? kept : dropped).push(i))

  const place = (i: number) => {
    const keep = KEEP.has(chunks[i]!.type)
    const lane = keep ? kept : dropped
    return { x: LANE.x + lane.indexOf(i) * SLOT, y: keep ? LANE.keep : LANE.drop }
  }
  const position = (i: number) => {
    if (i >= cur) return { x: GATE.x + (i - cur + 1 - prog) * SLOT, y: GATE.y }
    const to = place(i)
    if (i < cur - 1) return to
    return { x: GATE.x + (to.x - GATE.x) * prog, y: GATE.y + (to.y - GATE.y) * prog }
  }

  const TRACK = 560
  const BUDGET = 360
  const normal = steps(t, S + 5 * BEAT, EIGHTH * 2, 8)
  const bombTry = steps(t, S + 7 * BEAT, EIGHTH, 4)

  return (
    <Scene>
      <Title zh="上传的 PNG，先过安检" en="Every uploaded PNG gets inspected" />
      {/* 闸门 */}
      <div
        className="border-2 border-t-8 border-accent bg-accent-subtle"
        style={abs(GATE.x - 10, GATE.y - 30, { width: W + 20, height: H + 76 })}
      />
      <div style={abs(GATE.x - 10, GATE.y + H + 52, { width: W + 20, textAlign: 'center' })}>
        <Px size={12} tone="accent">
          CRC32
        </Px>
      </div>
      <div style={abs(LANE.x, LANE.keep - 30)}>
        <Px size={12} tone="muted">
          交给解码 · IHDR PLTE tRNS IDAT IEND
        </Px>
      </div>
      <div style={abs(LANE.x, LANE.drop + H + 10, enter(t, S + BEAT))}>
        <Px size={12} tone="muted">
          附加块一律丢掉 · ANCILLARY CHUNKS DROPPED
        </Px>
      </div>
      {chunks.map((ch, i) => {
        const p = position(i)
        if (p.x > 1216 - W) return null
        const keep = KEEP.has(ch.type)
        const done = i < cur || (i === cur - 1 && prog === 1)
        const atGate = i === cur
        return (
          <div key={i} style={abs(Math.round(p.x), Math.round(p.y))}>
            <Panel
              shadow={atGate ? 4 : 0}
              bg={done && !keep ? 'none' : 'surface'}
              edge={atGate ? 'accent' : done && keep ? 'success' : 'border'}
              thick={atGate || (done && keep)}
              dashed={done && !keep}
              style={{ width: W, height: H, padding: '6px 10px', opacity: done && !keep ? 0.6 : 1 }}
            >
              <div className="flex items-center justify-between">
                <Px size={24} tone={keep ? 'text' : 'muted'}>
                  {ch.type}
                </Px>
                {i <= cur && <Mark ok={keep} cell={2} />}
              </div>
              <Mono size={12} tone="muted">
                {atGate ? `crc ${ch.crc}` : `${fmt(ch.length)} B`}
              </Mono>
            </Panel>
          </div>
        )
      })}

      <div style={abs(64, 476, { width: 1152, ...enter(t, S + 5 * BEAT) })}>
        <Panel bg="sunken" shadow={4} className="flex" style={{ height: 188, padding: '20px 24px', gap: 32 }}>
          <div style={{ width: 460 }}>
            <Px size={24}>按 IHDR 算出解压后的精确长度</Px>
            <Mono size={22} tone="accent" style={{ marginTop: 10 }}>
              (64 × 4 + 1) × 64 = {fmt(expectedInflatedBytes)} B
            </Mono>
            <Px size={12} tone="muted" style={{ marginTop: 10 }}>
              宽高只写 64×64 的文件，也能解压出几百 MB
            </Px>
            <Px size={12} tone="muted">
              A 64×64 HEADER CAN STILL INFLATE TO HUNDREDS OF MB
            </Px>
          </div>
          <div className="flex flex-1 flex-col" style={{ gap: 18 }}>
            <Meter label="default-skin.png" fill={(normal * BUDGET) / TRACK} track={TRACK} budget={BUDGET}>
              {normal === 1 && (
                <>
                  <Mark ok cell={2} />
                  <Mono size={14} tone="success">
                    {fmt(expectedInflatedBytes)} B，正好
                  </Mono>
                </>
              )}
            </Meter>
            {t >= S + 7 * BEAT && (
              <Meter
                label={`解压炸弹 · 文件 ${Math.round(bombFile / 1024)} KB，要解出 ${bombInflated / 1024 / 1024} MiB`}
                fill={Math.min(bombTry * TRACK, BUDGET) / TRACK}
                ghost={bombTry}
                track={TRACK}
                budget={BUDGET}
                danger
              >
                {t >= S + 8 * BEAT && (
                  <>
                    <Mark ok={false} cell={2} />
                    <Mono size={14} tone="danger">
                      PngError: {bombError}
                    </Mono>
                  </>
                )}
              </Meter>
            )}
          </div>
        </Panel>
      </div>
    </Scene>
  )
}

function Meter({
  label,
  fill,
  ghost = 0,
  track,
  budget,
  danger = false,
  children,
}: {
  label: string
  fill: number
  ghost?: number
  track: number
  budget: number
  danger?: boolean
  children?: ReactNode
}) {
  return (
    <div>
      <Mono size={14} tone="muted">
        {label}
      </Mono>
      <div className="relative border border-border bg-surface" style={{ width: track, height: 20, marginTop: 4 }}>
        {/* 炸弹想解出来的部分：虚的，冲出预算线 */}
        {ghost > 0 && <div className="hatch-danger" style={abs(0, 0, { width: ghost * track, height: 18 })} />}
        <div
          className={cx(danger ? 'bg-danger' : 'bg-success')}
          style={abs(0, 0, { width: fill * track, height: 18 })}
        />
        <div className="bg-text" style={abs(budget, -6, { width: 3, height: 30 })} />
      </div>
      <div className="flex items-center" style={{ gap: 8, height: 22, marginTop: 4 }}>
        {children}
      </div>
    </div>
  )
}

export const pngGate: Page = {
  id: 'png',
  Scene: PngGate,
  duration: S + 8 * BEAT + SIXTEENTH,
  hold: 5,
  chapter: { no: '06', zh: '材质', en: 'TEXTURES' },
  text: {
    title: '上传的 PNG，先过安检',
    en: 'Every uploaded PNG gets inspected',
    body: [
      '上传的 PNG 逐块核对 CRC，只把 IHDR、PLTE、tRNS、IDAT、IEND 交给解码，色彩配置、文字、时间这些附加块一律丢掉。',
      '解码之前先按 IHDR 的宽高算出解压后的精确长度。一个宽高只写 64×64 的文件也能解压出几百 MB：这样的解压炸弹在预算处就被截住，不会把服务器的内存吃光。',
    ],
  },
}
